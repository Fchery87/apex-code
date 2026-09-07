import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";

describe("bash provider schema", () => {
	let previousCwd: string;
	let cwd: string;

	beforeEach(() => {
		previousCwd = process.cwd();
		cwd = mkdtempSync(join(tmpdir(), "apex-bash-schema-"));
		process.chdir(cwd);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(cwd, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each(["0", "1"])("advertises every operation to Anthropic with experimental=%s", async (experimental) => {
		vi.stubEnv("APEX_CODE_EXPERIMENTAL", experimental);
		const tool = createBashTool(cwd);
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Unexpected network request"));
		let payload: unknown;
		const result = await stream(
			getModel("anthropic", "claude-sonnet-4-5")!,
			{
				messages: [{ role: "user", content: "Run pwd", timestamp: Date.now() }],
				tools: [tool],
			},
			{
				apiKey: "unused-offline-test",
				fetch,
				onPayload(value) {
					payload = value;
					throw new Error("Captured tool schema before network request");
				},
			},
		).result();

		expect(result.errorMessage).toBe("Captured tool schema before network request");
		expect(fetch).not.toHaveBeenCalled();
		expect(payload).toMatchObject({
			tools: [
				{
					name: "bash",
					input_schema: {
						type: "object",
						required: [],
						properties: {
							command: { type: "string", description: expect.any(String) },
							timeout: { type: "number" },
							background: { type: "boolean" },
							handle: { type: "string", description: expect.any(String) },
							kill: { const: true, description: expect.any(String) },
						},
					},
				},
			],
		});
	});

	it.each([
		{ command: "pwd" },
		{ command: "pwd", timeout: 5 },
		{ command: "pwd", background: true },
		{ handle: "background-handle" },
		{ handle: "background-handle", kill: true },
	])("validates the existing call form %j", (args) => {
		const tool = createBashTool(cwd);
		expect(validateToolArguments(tool, { type: "toolCall", id: "validate", name: "bash", arguments: args })).toEqual(
			args,
		);
	});

	it("rejects an empty call before permission evaluation or execution", async () => {
		const tool = createBashTool(cwd);
		const execute = vi.spyOn(tool, "execute");
		const beforeToolCall = vi.fn(async () => undefined);
		const { streamFn } = createFauxStreamFn([{ toolCalls: [{ name: "bash", args: {} }] }, "done"]);
		const agent = new Agent({
			initialState: { model: fauxModel, tools: [tool] },
			streamFn,
			beforeToolCall,
		});

		await agent.prompt("Run pwd");

		expect(beforeToolCall).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: expect.stringContaining('Validation failed for tool "bash"') }],
		});
	});
});
