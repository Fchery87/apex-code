import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_EVICTION_MARKER } from "../../src/core/context/eviction.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ApexToolDefinition } from "../../src/core/tools/contract.ts";
import { UNCLASSIFIED } from "../../src/core/tools/contract.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

/**
 * Task 3.3: wiring deferred-schema resolution and eviction into the request
 * pipeline ahead of every LLM request (`docs/architecture/contracts.md` § 2).
 *
 * These tests drive a real `AgentSession` end to end, with a faux stream function
 * standing in for the provider (see `test-harness.ts`), so the outbound `Context`
 * actually built for "the model" can be inspected directly via `faux.contexts`.
 *
 * A distinctive property name on the deferred tool's real schema
 * (`RISKY_PARAM_NAME`) is used to detect whether the full schema leaked into an
 * announced tool, mirroring `deferred-schemas.test.ts`'s own technique.
 */

const RISKY_PARAM_NAME = "riskyUndisclosedParameter";

// 3000 chars ~= 750 estimated tokens (chars/4, see core/compaction/compaction.ts).
// Comfortably over the eviction budget derived below, so eviction is guaranteed to
// fire deterministically rather than sitting on a boundary.
const BIG_RESULT_TEXT = "x".repeat(3000);

// contextWindow=4500, reserveTokens=3200 (via settings override below) makes
// _evictionBudget() = floor((4500 - 3200) / 2) = 650 estimated tokens (2600 chars).
// BIG_RESULT_TEXT (~750 tokens) is over that budget, so it evicts. The resulting
// context stays below the auto-compaction threshold (4500 - 3200 = 1300 tokens),
// which keeps this test focused on the request pipeline rather than compaction.
const CONTEXT_WINDOW = 4500;
const RESERVE_TOKENS = 3200;

function buildEvictableTool(): ApexToolDefinition {
	return {
		name: "big_read",
		label: "Big Read",
		description: "Reads a large, recoverable resource.",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: BIG_RESULT_TEXT }],
			details: {},
		}),
		contract: {
			...UNCLASSIFIED,
			context: { resultRecoverable: true, deferSchema: false },
		},
	};
}

function buildDeferredTool(): ApexToolDefinition {
	return {
		name: "secret_tool",
		label: "Secret Tool",
		description: "A tool whose parameter schema should be withheld until loaded on demand.",
		parameters: Type.Object({
			[RISKY_PARAM_NAME]: Type.String({ description: "Should never appear in the announced form." }),
		}),
		execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
		contract: {
			...UNCLASSIFIED,
			context: { resultRecoverable: false, deferSchema: true },
		},
	};
}

async function buildSession(sessionManager: SessionManager, tempDir: string) {
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	settingsManager.applyOverrides({ compaction: { reserveTokens: RESERVE_TOKENS } });

	const model = { ...fauxModel, contextWindow: CONTEXT_WINDOW };

	const { streamFn, state: faux } = createFauxStreamFn([
		{ toolCalls: [{ name: "big_read", args: {} }] },
		"first done",
		"second done",
	]);

	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: "You are a test assistant.",
			tools: [],
		},
		streamFn,
	});

	const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		customTools: [buildEvictableTool(), buildDeferredTool()],
	});

	return { session, faux };
}

describe("context pipeline wiring (task 3.3)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-wiring-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("applies deferred-schema resolution and eviction together, ahead of the LLM request, without re-processing an already-evicted result", async () => {
		const sessionManager = SessionManager.inMemory();
		const { session, faux } = await buildSession(sessionManager, tempDir);

		await session.prompt("go");
		await session.agent.waitForIdle();

		// Turn 1 makes two LLM requests: the first before any tool has run, the
		// second right after `big_read`'s result has been appended to history.
		expect(faux.callCount).toBeGreaterThanOrEqual(2);

		// -- Deferred-schema resolution: present from the very first request, since
		// it projects the (fixed, per-turn) tool list, not the growing message list.
		const firstTools = faux.contexts[0].tools ?? [];
		const secretToolFirst = firstTools.find((t) => t.name === "secret_tool");
		expect(secretToolFirst).toBeDefined();
		expect(JSON.stringify(secretToolFirst?.parameters)).not.toContain(RISKY_PARAM_NAME);

		// -- Eviction: absent on the first request (nothing to evict yet)...
		const firstToolResult = faux.contexts[0].messages.find((m) => m.role === "toolResult");
		expect(firstToolResult).toBeUndefined();

		// ...present on the second request, once the big tool result exists.
		const secondToolResult = faux.contexts[1].messages.find((m) => m.role === "toolResult") as
			| { content: Array<{ type: string; text?: string }> }
			| undefined;
		expect(secondToolResult).toBeDefined();
		expect(secondToolResult?.content).toEqual([{ type: "text", text: DEFAULT_EVICTION_MARKER }]);

		// -- Both effects present simultaneously in the same outbound request.
		const secondTools = faux.contexts[1].tools ?? [];
		const secretToolSecond = secondTools.find((t) => t.name === "secret_tool");
		expect(JSON.stringify(secretToolSecond?.parameters)).not.toContain(RISKY_PARAM_NAME);

		// Drive a further turn. The already-evicted result must not be un-evicted,
		// re-evicted into a different marker, or otherwise reprocessed.
		await session.prompt("continue");
		await session.agent.waitForIdle();

		const lastContext = faux.contexts[faux.contexts.length - 1];
		const persistedToolResult = lastContext.messages.find((m) => m.role === "toolResult") as
			| { content: Array<{ type: string; text?: string }> }
			| undefined;
		expect(persistedToolResult).toBeDefined();
		expect(persistedToolResult?.content).toEqual([{ type: "text", text: DEFAULT_EVICTION_MARKER }]);

		session.dispose();
	});

	it("never rewrites the on-disk session — eviction only rewrites the outbound copy (Phase 7 constraint)", async () => {
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const { session, faux } = await buildSession(sessionManager, tempDir);

		await session.prompt("go");
		await session.agent.waitForIdle();

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		if (!sessionFile) throw new Error("expected a session file");

		const snapshotAfterTurn1 = readFileSync(sessionFile, "utf8");

		// The outbound copy for turn 1's second request was evicted...
		const turn1SecondContext = faux.contexts[1];
		const turn1ToolResult = turn1SecondContext.messages.find((m) => m.role === "toolResult") as
			| { content: Array<{ type: string; text?: string }> }
			| undefined;
		expect(turn1ToolResult?.content).toEqual([{ type: "text", text: DEFAULT_EVICTION_MARKER }]);

		// ...but the persisted session still holds the full, original tool result.
		expect(snapshotAfterTurn1).toContain(BIG_RESULT_TEXT);
		expect(snapshotAfterTurn1).not.toContain(DEFAULT_EVICTION_MARKER);

		// Drive a second turn: eviction fires again on its outbound request (there is
		// still a big recoverable result sitting in history), but the file on disk
		// must only ever grow by strict append — the bytes already written for turn 1
		// must be untouched.
		await session.prompt("continue");
		await session.agent.waitForIdle();

		const snapshotAfterTurn2 = readFileSync(sessionFile, "utf8");
		expect(snapshotAfterTurn2.startsWith(snapshotAfterTurn1)).toBe(true);
		expect(snapshotAfterTurn2).toContain(BIG_RESULT_TEXT);
		expect(snapshotAfterTurn2).not.toContain(DEFAULT_EVICTION_MARKER);

		session.dispose();
	});
});
