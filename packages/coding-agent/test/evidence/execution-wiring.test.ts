import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { ApexToolDefinition, EvidenceSink } from "../../src/core/tools/contract.ts";

const directories: string[] = [];

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-evidence-wiring-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

function assistantWithTool(name: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name, arguments: { value: "source" } }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("AgentSession evidence wiring", () => {
	it("captures raw completed tool facts once, before extension presentation hooks", async () => {
		const cwd = scratchDirectory();
		const parameters = Type.Object({ value: Type.String() });
		const fixture: ApexToolDefinition = {
			name: "fixture",
			label: "Fixture",
			description: "A source evidence fixture",
			parameters,
			contract: {
				capabilities: new Set(),
				permission: { defaultBehavior: "allow", matches: () => false, describe: () => "", ruleForCall: () => null },
				context: { resultRecoverable: true, deferSchema: false },
				evidence: {
					emits: new Set(["manual"]),
					capture: (params, result) => [
						{
							kind: "manual",
							value:
								typeof params === "object" && params !== null && "value" in params ? params.value : undefined,
							observed:
								typeof result.details === "object" && result.details !== null && "observed" in result.details
									? result.details.observed
									: undefined,
						},
					],
				},
			},
			execute: async (): Promise<AgentToolResult<unknown>> => ({
				content: [{ type: "text", text: "fixture" }],
				details: { observed: "raw" },
			}),
		};
		const recorded: Array<{ toolName: string; records: unknown[] }> = [];
		const sink: EvidenceSink = { record: (entry) => recorded.push(entry) };
		const { session } = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			customTools: [fixture],
			evidenceSink: sink,
		});
		const after = session.agent.afterToolCall;
		expect(after).toBeDefined();
		await after!({
			assistantMessage: assistantWithTool("fixture"),
			toolCall: { type: "toolCall", id: "call-1", name: "fixture", arguments: { value: "source" } },
			args: { value: "source" },
			result: { content: [{ type: "text", text: "presented" }], details: { observed: "raw" } },
			isError: false,
			context: { systemPrompt: "", messages: [], tools: [] },
		});
		expect(recorded).toEqual([
			{ toolName: "fixture", records: [{ kind: "manual", value: "source", observed: "raw" }] },
		]);
		session.dispose();
	});
	it("keeps completed tool results successful when the evidence sink rejects a record", async () => {
		const cwd = scratchDirectory();
		const parameters = Type.Object({ value: Type.String() });
		const fixture: ApexToolDefinition = {
			name: "sink_failure_fixture",
			label: "Sink failure fixture",
			description: "A source evidence fixture",
			parameters,
			contract: {
				capabilities: new Set(),
				permission: { defaultBehavior: "allow", matches: () => false, describe: () => "", ruleForCall: () => null },
				context: { resultRecoverable: true, deferSchema: false },
				evidence: { emits: new Set(["manual"]), capture: () => [{ kind: "manual", status: "observed" }] },
			},
			execute: async (): Promise<AgentToolResult<unknown>> => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
		};
		const diagnostics: unknown[] = [];
		const sink: EvidenceSink = {
			record: () => {
				throw new Error("sink unavailable");
			},
			recordDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		};
		const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), model: getModel("anthropic", "claude-sonnet-4-5")!, customTools: [fixture], evidenceSink: sink });
		const after = await session.agent.afterToolCall!({
			assistantMessage: assistantWithTool("sink_failure_fixture"),
			toolCall: { type: "toolCall", id: "call-1", name: "sink_failure_fixture", arguments: { value: "source" } },
			args: { value: "source" },
			result: { content: [{ type: "text", text: "fixture" }], details: {} },
			isError: false,
			context: { systemPrompt: "", messages: [], tools: [] },
		});
		expect(after).toBeUndefined();
		expect(diagnostics).toEqual([{ toolName: "sink_failure_fixture", reason: "sink unavailable" }]);
		session.dispose();
	});

});
