import { describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import type { Capability } from "../../src/core/tools/contract.ts";
import { createWorkflowToolDefinition } from "../../src/core/tools/workflow.ts";

/**
 * The tool's own seam: a script the model just wrote is shown before it runs,
 * and declining it starts nothing. The runner's behavior is covered in
 * workflow.test.ts.
 */

function runtime(): DelegationRuntimeOptions {
	return {
		resolveAgent: () => undefined,
		getParentCapabilities: () => new Set<Capability>(["delegate"]),
		getToolCapabilities: () => undefined,
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		buildChildSession: async () => {
			throw new Error("declining must not build a child");
		},
	};
}

describe("workflow tool", () => {
	it("starts nothing when the user declines the script", async () => {
		const tool = createWorkflowToolDefinition(runtime());
		const select = vi.fn(async () => "Don't run");
		await expect(
			tool.execute("call-1", { script: "return 1" }, undefined, undefined, {
				hasUI: true,
				ui: { select },
			} as never),
		).rejects.toThrow(/declined/);
		expect(select).toHaveBeenCalledOnce();
	});

	it("refuses a new script in a session with no UI", async () => {
		const tool = createWorkflowToolDefinition(runtime());
		await expect(
			tool.execute("call-2", { script: "return 2" }, undefined, undefined, { hasUI: false } as never),
		).rejects.toThrow(/no UI/);
	});

	it("runs a named script without asking", async () => {
		const tool = createWorkflowToolDefinition(runtime());
		const result = await tool.execute("call-3", { script: "return 3", name: "audit" }, undefined, undefined, {
			hasUI: false,
		} as never);
		expect(result.details.output).toBe("3");
		expect(result.details.calls).toBe(0);
	});

	it("returns the phase titles and the calls under each", async () => {
		const tool = createWorkflowToolDefinition(runtime());
		const result = await tool.execute(
			"call-4",
			{ script: 'phase("scan");\nphase("rank");\nreturn "done"', name: "audit" },
			undefined,
			undefined,
			{ hasUI: false } as never,
		);
		expect(result.details.phases).toEqual([
			{ title: "scan", calls: 0 },
			{ title: "rank", calls: 0 },
		]);
	});
});
