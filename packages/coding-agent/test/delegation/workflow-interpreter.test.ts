import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { runWorkflow } from "../../src/core/delegation/workflow-run.ts";

let root: string;
const cwd = process.cwd();
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "apex-h2-interpreter-"));
	process.chdir(root);
});
afterEach(() => {
	process.chdir(cwd);
	rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
function runtime(output: (prompt: string) => string) {
	const close = vi.fn();
	const dispose = vi.fn();
	const build = vi.fn(async () => ({
		status: "idle" as const,
		run: async (prompt: string) => ({ output: output(prompt) }),
		latestResult: () => undefined,
		wait: async () => {},
		interrupt: () => {},
		close,
		sendInput: async () => {},
		followUp: async () => {},
		dispose,
	}));
	const options: DelegationRuntimeOptions = {
		resolveAgent: () => ({ name: "explore", description: "reads", tools: ["read"], systemPrompt: "read" }),
		getParentCapabilities: () => new Set(["delegate", "fs.read"]),
		getToolCapabilities: () => new Set(["fs.read"]),
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		getParentSessionDir: () => root,
		buildChildSession: build,
	};
	return { options, build, close, dispose };
}
function input(steps: unknown[], from = "one", args?: unknown) {
	return { kind: "inline", definition: { version: 1, steps, output: { from } }, args };
}
describe("H2 JSON graph interpreter", () => {
	it("runs a worker and closes the child", async () => {
		const r = runtime((prompt) => `result:${prompt}`);
		const result = await runWorkflow(r.options, input([{ id: "one", prompt: "scan" }]));
		expect(result.value).toBe("result:scan");
		expect(result.outcome).toBe("succeeded");
		expect(result.calls[0]).toMatchObject({ stepId: "one", outcome: "succeeded" });
		expect(r.close).toHaveBeenCalledOnce();
	});
	it("orders an out-of-order pipeline and renders args and predecessor pointers", async () => {
		const r = runtime((prompt) => (prompt === "scan src" ? '{"value":"next"}' : prompt));
		const result = await runWorkflow(
			r.options,
			input(
				[
					{ id: "two", needs: ["one"], prompt: ["saw:", { from: "one", pointer: "/value" }] },
					{ id: "one", prompt: ["scan ", { from: "args", pointer: "/path" }] },
				],
				"two",
				{ path: "src" },
			),
		);
		expect(result.value).toBe("saw:next");
		expect(result.calls.map((call) => call.stepId)).toEqual(["one", "two"]);
	});
	it("preserves independent parallel-shaped steps and phase counts", async () => {
		const r = runtime((prompt) => prompt);
		const result = await runWorkflow(
			r.options,
			input(
				[
					{ id: "one", prompt: "a", phase: "scan" },
					{ id: "two", prompt: "b", phase: "scan" },
				],
				"two",
			),
		);
		expect(result.value).toBe("b");
		expect(result.calls.map((call) => call.stepId)).toEqual(["one", "two"]);
		expect(result.phases).toEqual([{ title: "scan", calls: 2 }]);
	});
	it("validates all graph dependencies and schemas before any dispatch", async () => {
		for (const bad of [
			{ id: "two", prompt: "bad", needs: ["missing"] },
			{ id: "two", prompt: "bad", schema: { $ref: "remote" } },
		]) {
			const r = runtime(() => "ok");
			await expect(runWorkflow(r.options, input([{ id: "one", prompt: "valid" }, bad]))).rejects.toThrow();
			expect(r.build).not.toHaveBeenCalled();
		}
	});
	it("validates output before a dependent can consume it and closes failed children", async () => {
		const r = runtime(() => '{"count":"wrong"}');
		await expect(
			runWorkflow(
				r.options,
				input([
					{ id: "one", prompt: "scan", schema: { type: "object", properties: { count: { type: "integer" } } } },
					{ id: "two", needs: ["one"], prompt: "never" },
				]),
			),
		).rejects.toThrow(/type|integer/i);
		expect(r.build).toHaveBeenCalledOnce();
		expect(r.close).toHaveBeenCalledOnce();
	});
	it("returns schema-checked structured output", async () => {
		const r = runtime(() => '{"files":["a.ts"]}');
		const result = await runWorkflow(
			r.options,
			input([
				{
					id: "one",
					prompt: "scan",
					schema: {
						type: "object",
						properties: { files: { type: "array", items: { type: "string" } } },
						required: ["files"],
						additionalProperties: false,
					},
				},
			]),
		);
		expect(result.value).toEqual({ files: ["a.ts"] });
	});
});
