import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createPlanPresentTool, createPlanPresentToolDefinition } from "../../src/core/tools/plan-present.ts";

function fakeCtx(overrides: {
	hasUI: boolean;
	confirm?: (title: string, message: string) => Promise<boolean>;
}): ExtensionContext {
	return {
		hasUI: overrides.hasUI,
		ui: {
			confirm: overrides.confirm ?? (async () => false),
		},
	} as unknown as ExtensionContext;
}

describe("plan_present contract (task 4.5)", () => {
	it("declares the ui capability, allow default, null ruleForCall, workflow evidence, and an undeferred schema", () => {
		const definition = createPlanPresentToolDefinition();
		expect([...definition.contract.capabilities]).toEqual(["ui"]);
		expect(definition.contract.permission.defaultBehavior).toBe("allow");
		expect(definition.contract.permission.ruleForCall({ plan: "1. Do a thing" })).toBeNull();
		// Called on nearly every plan-mode turn -- same exclusion reasoning as read/bash/edit/write:
		// deferring it would trade a one-time prefix saving for a recurring round trip.
		expect(definition.contract.context.deferSchema).toBe(false);
		expect(definition.contract.context.resultRecoverable).toBe(false);
		expect([...definition.contract.evidence.emits]).toEqual(["workflow"]);
	});

	it("never matches any rule content, since ruleForCall never generates one", () => {
		const definition = createPlanPresentToolDefinition();
		expect(definition.contract.permission.matches("**", { plan: "1. Do a thing" })).toBe(false);
	});

	it("captures a workflow evidence record with the plan and the approval decision", () => {
		const definition = createPlanPresentToolDefinition();
		const params = { plan: "1. Do a thing" };
		const result = { content: [], details: { plan: params.plan, approved: true } };
		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{ kind: "workflow", plan: "1. Do a thing", approved: true },
		]);
	});
});

describe("plan_present execution (task 4.5)", () => {
	it("presents the plan through ctx.ui.confirm and reports approval", async () => {
		const confirm = vi.fn(async () => true);
		const definition = createPlanPresentToolDefinition();

		const result = await definition.execute(
			"call-1",
			{ plan: "1. Read the code\n2. Write the fix" },
			undefined,
			undefined,
			fakeCtx({ hasUI: true, confirm }),
		);

		expect(confirm).toHaveBeenCalledWith(expect.any(String), "1. Read the code\n2. Write the fix");
		expect(result.details).toEqual({ plan: "1. Read the code\n2. Write the fix", approved: true });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/approved/i);
	});

	it("reports rejection distinctly from approval", async () => {
		const definition = createPlanPresentToolDefinition();

		const result = await definition.execute(
			"call-1",
			{ plan: "1. Do a risky thing" },
			undefined,
			undefined,
			fakeCtx({ hasUI: true, confirm: async () => false }),
		);

		expect(result.details).toEqual({ plan: "1. Do a risky thing", approved: false });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/not approved|rejected/i);
	});
});

describe("plan_present fails closed without interactive UI (task 4.5)", () => {
	it("throws rather than silently treating the no-op UI's resolved false as a real rejection, when ctx.hasUI is false", async () => {
		const confirm = vi.fn(async () => false);
		const definition = createPlanPresentToolDefinition();

		await expect(
			definition.execute("call-1", { plan: "1. Step" }, undefined, undefined, fakeCtx({ hasUI: false, confirm })),
		).rejects.toThrow(/interactive UI|not available|headless/i);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("throws when called with no context at all", async () => {
		const tool = createPlanPresentTool();
		await expect(tool.execute("call-1", { plan: "1. Step" })).rejects.toThrow(
			/interactive UI|not available|headless/i,
		);
	});
});
