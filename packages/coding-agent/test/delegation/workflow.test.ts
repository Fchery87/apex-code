import { describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { runWorkflow } from "../../src/core/delegation/workflow-run.ts";

describe("runWorkflow migration boundary", () => {
	it.each([
		"return 3",
		'return await worker("audit")',
		'return await parallel(["audit"])',
		'return await pipeline(["audit"], item => item)',
		'return globalThis.constructor.constructor("return process")()',
		"import('node:fs')",
		"1".repeat(70_000),
	])("refuses legacy JavaScript before touching runtime state: %.50s", async (script) => {
		const touched = vi.fn(() => {
			throw new Error("runtime must not be touched");
		});
		const runtime: DelegationRuntimeOptions = {
			resolveAgent: touched,
			getParentCapabilities: touched,
			getToolCapabilities: touched,
			getDelegationDepth: touched,
			maxDelegationDepth: 2,
			getParentSessionDir: touched,
			buildChildSession: touched,
		};
		await expect(runWorkflow(runtime, script, { runId: "../../outside", args: {} })).rejects.toThrow(
			/workflow.*disabled.*migration/i,
		);
		expect(touched).not.toHaveBeenCalled();
	});
});
