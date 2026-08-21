/**
 * The /settings permission-mode row (AgentSession.setPermissionMode) writes to
 * `user` scope. These cover the two things that make such a row trustworthy: the
 * write has to actually change what the gate does, and when a higher-precedence
 * source outranks it the caller has to be told rather than shown a toggle that
 * silently does nothing.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionResponder } from "../../src/core/permissions/responder.ts";
import { resolveEffectiveModeWithOrigin } from "../../src/core/permissions/startup.ts";
import { FilePermissionRuleStore, type PermissionMode } from "../../src/core/permissions/store.ts";
import type { ToolContract } from "../../src/core/tools/contract.ts";

const sharedTempDir = join(tmpdir(), `apex-settings-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => mkdirSync(sharedTempDir, { recursive: true }));
afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

const paramsSchema = Type.Object({ command: Type.String() });

/** Defaults to `ask`, so anything that reaches the responder was not auto-allowed. */
const askingContract: ToolContract<typeof paramsSchema> = {
	capabilities: new Set(["exec"]),
	permission: {
		defaultBehavior: "ask",
		matches: (ruleContent, params) => ruleContent === params.command,
		describe: (ruleContent) => `run ${ruleContent}`,
		ruleForCall: (params) => params.command,
	},
	context: { resultRecoverable: true, deferSchema: false },
	evidence: { emits: new Set(), capture: () => [] },
};

function scope(name: string) {
	const cwd = join(sharedTempDir, name, "project");
	const agentDir = join(sharedTempDir, name, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir, policyPath: join(sharedTempDir, name, "missing-policy.json") };
}

/** Mirrors AgentSession.setPermissionMode: write user scope, report what is in force. */
async function setPermissionMode(
	store: FilePermissionRuleStore,
	flagMode: PermissionMode | undefined,
	mode: PermissionMode,
) {
	await store.apply({ type: "setMode", destination: "user", mode });
	return resolveEffectiveModeWithOrigin(flagMode, (await store.snapshot()).modesBySource);
}

function recordingResponder(): PermissionResponder & { asked: number } {
	const responder = {
		asked: 0,
		async ask() {
			responder.asked += 1;
			return { allow: false };
		},
	};
	return responder;
}

async function evaluate(store: FilePermissionRuleStore, flagMode: PermissionMode | undefined) {
	const responder = recordingResponder();
	const decision = await evaluateToolCall(
		"bash",
		{ command: "rm -rf build" },
		{
			getContract: () => askingContract as ToolContract,
			store,
			flagMode,
			getMode: async () => resolveEffectiveModeWithOrigin(flagMode, (await store.snapshot()).modesBySource).mode,
			responder,
		},
	);
	return { decision, asked: responder.asked };
}

describe("permission mode written from /settings", () => {
	it("stops the gate asking once bypassPermissions is saved", async () => {
		const paths = scope("bypass-applies");
		const store = new FilePermissionRuleStore(paths);

		const before = await evaluate(store, undefined);
		expect(before.asked).toBe(1);
		expect(before.decision.block).toBe(true);

		const resolution = await setPermissionMode(store, undefined, "bypassPermissions");
		expect(resolution).toEqual({ mode: "bypassPermissions", origin: "user" });

		const after = await evaluate(store, undefined);
		expect(after.asked).toBe(0);
		expect(after.decision.block).toBe(false);
	});

	it("persists across a restart, so the setting survives the process that set it", async () => {
		const paths = scope("bypass-persists");
		await setPermissionMode(new FilePermissionRuleStore(paths), undefined, "bypassPermissions");

		const reopened = new FilePermissionRuleStore(paths);
		expect((await reopened.snapshot()).modesBySource.get("user")).toBe("bypassPermissions");
		expect((await evaluate(reopened, undefined)).decision.block).toBe(false);
	});

	it("reports the flag as in force when --permission-mode outranks the write", async () => {
		const paths = scope("flag-outranks");
		const store = new FilePermissionRuleStore(paths);

		const resolution = await setPermissionMode(store, "default", "bypassPermissions");
		expect(resolution).toEqual({ mode: "default", origin: "flag" });

		// The write landed; it is simply outranked for this run.
		expect((await store.snapshot()).modesBySource.get("user")).toBe("bypassPermissions");
		expect((await evaluate(store, "default")).asked).toBe(1);

		// ...and takes effect on the next run, where no flag is passed.
		expect((await evaluate(store, undefined)).decision.block).toBe(false);
	});

	it("reports the project file as in force when it outranks the write", async () => {
		const paths = scope("project-outranks");
		const store = new FilePermissionRuleStore(paths);
		await store.apply({ type: "setMode", destination: "project", mode: "plan" });

		expect(await setPermissionMode(store, undefined, "bypassPermissions")).toEqual({
			mode: "plan",
			origin: "project",
		});
	});

	it("switching back to default restores the prompt", async () => {
		const paths = scope("round-trip");
		const store = new FilePermissionRuleStore(paths);

		await setPermissionMode(store, undefined, "bypassPermissions");
		expect((await evaluate(store, undefined)).asked).toBe(0);

		expect(await setPermissionMode(store, undefined, "default")).toEqual({ mode: "default", origin: "user" });
		expect((await evaluate(store, undefined)).asked).toBe(1);
	});
});
