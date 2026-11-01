import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { createWorkflowToolDefinition } from "../../src/core/tools/workflow.ts";

const cwd = process.cwd();
let scratch: string | undefined;
afterEach(() => {
	process.chdir(cwd);
	if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	scratch = undefined;
});

describe("workflow terminal tool surface", () => {
	it.each(["cancelled", "failed"])("exposes a valid text result and explicit %s step outcome", async (outcome) => {
		scratch = mkdtempSync(join(tmpdir(), "apex-workflow-terminal-"));
		process.chdir(scratch);
		const runtime: DelegationRuntimeOptions = {
			resolveAgent: () => ({ name: "explore", description: "read", tools: ["read"], systemPrompt: "read" }),
			getParentCapabilities: () => new Set(["delegate", "fs.read"]),
			getToolCapabilities: () => new Set(["fs.read"]),
			getDelegationDepth: () => 0,
			maxDelegationDepth: 2,
			buildChildSession: () => {
				if (outcome === "failed") return Promise.reject(new Error("fixture failure"));
				return new Promise(() => {});
			},
		};
		const tool = createWorkflowToolDefinition(runtime);
		const result = await tool.execute(
			"terminal",
			{
				kind: "inline",
				definition: {
					version: 1,
					timeoutMs: 20,
					steps: [{ id: "one", prompt: "probe" }],
					output: { from: "one" },
				},
			},
			undefined,
			undefined,
			{ cwd: scratch } as never,
		);
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(outcome) }]);
		expect(result.details).toMatchObject({ outcome, steps: [{ stepId: "one", outcome }] });
		runtime.childRunRegistry?.dispose();
	});
});
