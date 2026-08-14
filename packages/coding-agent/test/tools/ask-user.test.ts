import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createAskUserTool, createAskUserToolDefinition } from "../../src/core/tools/ask-user.ts";

function fakeCtx(overrides: {
	hasUI: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
}): ExtensionContext {
	return {
		hasUI: overrides.hasUI,
		ui: {
			select: overrides.select ?? (async () => undefined),
		},
	} as unknown as ExtensionContext;
}

describe("ask_user contract (task 4.5)", () => {
	it("declares the ui capability, allow default, null ruleForCall, deferred schema, and no evidence", () => {
		const definition = createAskUserToolDefinition();
		expect([...definition.contract.capabilities]).toEqual(["ui"]);
		expect(definition.contract.permission.defaultBehavior).toBe("allow");
		expect(definition.contract.permission.ruleForCall({ question: "q", options: ["a", "b"] })).toBeNull();
		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.context.resultRecoverable).toBe(false);
		expect(definition.contract.evidence.emits.size).toBe(0);
	});

	it("never matches any rule content, since ruleForCall never generates one", () => {
		const definition = createAskUserToolDefinition();
		expect(definition.contract.permission.matches("**", { question: "q", options: ["a"] })).toBe(false);
	});

	it("renders a human-readable description", () => {
		const definition = createAskUserToolDefinition();
		expect(definition.contract.permission.describe("anything")).toMatch(/question/i);
	});
});

describe("ask_user execution (task 4.5)", () => {
	it("presents the question through ctx.ui.select and reports the chosen answer", async () => {
		const select = vi.fn(async () => "option-b");
		const definition = createAskUserToolDefinition();

		const result = await definition.execute(
			"call-1",
			{ question: "Which approach?", options: ["option-a", "option-b"] },
			undefined,
			undefined,
			fakeCtx({ hasUI: true, select }),
		);

		expect(select).toHaveBeenCalledWith("Which approach?", ["option-a", "option-b"]);
		expect(result.details).toEqual({ question: "Which approach?", answer: "option-b" });
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("reports no answer clearly when the user dismisses the question", async () => {
		const definition = createAskUserToolDefinition();

		const result = await definition.execute(
			"call-1",
			{ question: "Which approach?", options: ["a", "b"] },
			undefined,
			undefined,
			fakeCtx({ hasUI: true, select: async () => undefined }),
		);

		expect(result.details).toEqual({ question: "Which approach?", answer: undefined });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/no answer|did not answer|dismissed/i);
	});
});

describe("ask_user fails closed without interactive UI (task 4.5)", () => {
	it("throws rather than silently treating the no-op UI's resolved undefined as a real answer, when ctx.hasUI is false", async () => {
		const select = vi.fn(async () => undefined);
		const definition = createAskUserToolDefinition();

		await expect(
			definition.execute(
				"call-1",
				{ question: "q", options: ["a"] },
				undefined,
				undefined,
				fakeCtx({ hasUI: false, select }),
			),
		).rejects.toThrow(/interactive UI|not available|headless/i);
		expect(select).not.toHaveBeenCalled();
	});

	it("throws when called with no context at all", async () => {
		const tool = createAskUserTool();
		await expect(tool.execute("call-1", { question: "q", options: ["a"] })).rejects.toThrow(
			/interactive UI|not available|headless/i,
		);
	});
});
