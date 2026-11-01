import { describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createWorkflowTool, createWorkflowToolDefinition } from "../../src/core/tools/workflow.ts";

function runtime(): DelegationRuntimeOptions {
	const touched = () => {
		throw new Error("runtime must not be touched");
	};
	return {
		resolveAgent: touched,
		getParentCapabilities: touched,
		getToolCapabilities: touched,
		getDelegationDepth: touched,
		maxDelegationDepth: 2,
		buildChildSession: touched,
	};
}

describe("workflow tool migration boundary", () => {
	it.each([
		{ hasUI: true, name: undefined },
		{ hasUI: false, name: undefined },
		{ hasUI: true, name: "audit" },
		{ hasUI: false, name: "audit" },
	])("refuses without approval or child dispatch: %j", async ({ hasUI, name }) => {
		const select = vi.fn(async () => "Run");
		const tool = createWorkflowToolDefinition(runtime());
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				tool.execute("call", { script: "return 3", name }, undefined, undefined, {
					hasUI,
					ui: { select },
				} as never),
			).rejects.toThrow(/workflow.*disabled.*migration/i);
		}
		expect(select).not.toHaveBeenCalled();
	});

	it("does not confer authority through a model supplied saved name", () => {
		const permission = createWorkflowToolDefinition(runtime()).contract.permission;
		expect(permission.matches("*", { script: "return 3", name: "audit" })).toBe(false);
		expect(permission.ruleForCall?.({ script: "return 3", name: "audit" })).toBeNull();
	});

	it("denies disabled workflows without asking or dispatching", async () => {
		const responder = { ask: vi.fn(async () => ({ allow: true })) };
		const store = {
			snapshot: async () => ({ rules: [], modesBySource: new Map(), errors: [] }),
			apply: vi.fn(async () => undefined),
		} as unknown as PermissionRuleStore;
		const tool = createWorkflowToolDefinition(runtime());

		const decision = await evaluateToolCall(
			"workflow",
			{ script: "return 3" },
			{
				getContract: () => tool.contract,
				store,
				getMode: () => "default",
				responder,
			},
		);

		expect(decision).toEqual({
			block: true,
			reason: "workflow is not permitted by the current permission configuration.",
		});
		expect(responder.ask).not.toHaveBeenCalled();
		expect(store.apply).not.toHaveBeenCalled();
	});

	it("refuses at the wrapped public tool boundary too", async () => {
		await expect(
			createWorkflowTool(runtime()).execute("call", { script: "return 3", name: "audit" }),
		).rejects.toThrow(/workflow.*disabled.*migration/i);
	});
});
