import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createPlanPresentTool, createPlanPresentToolDefinition } from "../../src/core/tools/plan-present.ts";

function fakeCtx(overrides: {
	hasUI: boolean;
	select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
}): ExtensionContext {
	return {
		hasUI: overrides.hasUI,
		ui: {
			select: overrides.select ?? (async () => undefined),
			notify: vi.fn(),
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
	it("presents the plan through the three-way selector and reports approval", async () => {
		const select = vi.fn(async () => "Yes, and accept edits");
		const definition = createPlanPresentToolDefinition();

		const result = await definition.execute(
			"call-1",
			{ plan: "1. Read the code\n2. Write the fix" },
			undefined,
			undefined,
			fakeCtx({ hasUI: true, select }),
		);

		expect(select).toHaveBeenCalledWith(
			"Approve this plan?",
			["Yes, and accept edits", "Yes, and ask before each edit", "No, keep planning"],
			{ signal: undefined },
		);
		expect(result.details).toEqual({
			plan: "1. Read the code\n2. Write the fix",
			approved: true,
			nextMode: "acceptEdits",
		});
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
			fakeCtx({ hasUI: true, select: async () => "No, keep planning" }),
		);

		expect(result.details).toEqual({ plan: "1. Do a risky thing", approved: false });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/not approved|rejected/i);
	});
});

describe("plan_present fails closed without interactive UI (task 4.5)", () => {
	it("throws rather than silently treating the no-op UI's resolved false as a real rejection, when ctx.hasUI is false", async () => {
		const select = vi.fn(async () => undefined);
		const definition = createPlanPresentToolDefinition();

		await expect(
			definition.execute("call-1", { plan: "1. Step" }, undefined, undefined, fakeCtx({ hasUI: false, select })),
		).rejects.toThrow(/interactive UI|not available|headless/i);
		expect(select).not.toHaveBeenCalled();
	});

	it("throws when called with no context at all", async () => {
		const tool = createPlanPresentTool();
		await expect(tool.execute("call-1", { plan: "1. Step" })).rejects.toThrow(
			/interactive UI|not available|headless/i,
		);
	});
});

describe("injected plan presenter", () => {
	it.each(["acceptEdits", "default"] as const)("adds %s to result and evidence", async (nextMode) => {
		const present = vi.fn(async () => ({ approved: true as const, nextMode }));
		const tool = createPlanPresentToolDefinition({ present });
		const ctx = fakeCtx({ hasUI: false });
		const signal = new AbortController().signal;
		const result = await tool.execute("id", { plan: "Plan" }, signal, undefined, ctx);
		expect(present).toHaveBeenCalledWith("Plan", ctx, signal);
		expect(result.details).toEqual({ plan: "Plan", approved: true, nextMode });
		expect(tool.contract.evidence.capture({ plan: "Plan" }, result)).toEqual([
			{ kind: "workflow", plan: "Plan", approved: true, nextMode },
		]);
	});
	it("rejects cancelled approval", async () => {
		const controller = new AbortController();
		const tool = createPlanPresentToolDefinition({
			present: async () => {
				controller.abort();
				return { approved: true, nextMode: "default" };
			},
		});
		await expect(
			tool.execute("id", { plan: "Plan" }, controller.signal, undefined, fakeCtx({ hasUI: false })),
		).rejects.toThrow(/abort|cancel/i);
	});
	it("maps the ask choice to default", async () => {
		const result = await createPlanPresentToolDefinition().execute(
			"id",
			{ plan: "Plan" },
			undefined,
			undefined,
			fakeCtx({ hasUI: true, select: async () => "Yes, and ask before each edit" }),
		);
		expect(result.details).toEqual({ plan: "Plan", approved: true, nextMode: "default" });
	});
});
