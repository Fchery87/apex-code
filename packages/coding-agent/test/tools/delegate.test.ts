import { describe, expect, it } from "vitest";
import { createDelegateToolDefinition } from "../../src/core/tools/delegate.ts";

describe("delegate contract (task 4.6: entry point only)", () => {
	it("declares the delegate capability, ask default, deferred schema, and workflow evidence", () => {
		const definition = createDelegateToolDefinition();
		expect([...definition.contract.capabilities]).toEqual(["delegate"]);
		expect(definition.contract.permission.defaultBehavior).toBe("ask");
		expect(definition.contract.context.deferSchema).toBe(true);
		expect([...definition.contract.evidence.emits]).toEqual(["workflow"]);
	});
});

describe("delegate rule grammar: agent-type glob (task 4.6)", () => {
	it("ruleForCall generates the exact agent type of the call, never a pattern the tool did not generate itself", () => {
		const definition = createDelegateToolDefinition();
		const rule = definition.contract.permission.ruleForCall({ agentType: "explore", task: "find the config loader" });
		expect(rule).toBe("explore");
	});

	it("an auto-generated rule matches only the exact agent type it came from", () => {
		const definition = createDelegateToolDefinition();
		const rule = definition.contract.permission.ruleForCall({ agentType: "explore", task: "x" }) as string;
		expect(definition.contract.permission.matches(rule, { agentType: "explore", task: "anything" })).toBe(true);
		expect(definition.contract.permission.matches(rule, { agentType: "general-purpose", task: "x" })).toBe(false);
	});

	it("a hand-authored agent-type glob (explore:*) matches namespaced agent types under that prefix", () => {
		const definition = createDelegateToolDefinition();
		const glob = "explore:*";
		expect(definition.contract.permission.matches(glob, { agentType: "explore:quick", task: "x" })).toBe(true);
		expect(definition.contract.permission.matches(glob, { agentType: "explore:thorough", task: "x" })).toBe(true);
		expect(definition.contract.permission.matches(glob, { agentType: "general-purpose", task: "x" })).toBe(false);
	});

	it("renders a human-readable description of the rule content", () => {
		const definition = createDelegateToolDefinition();
		expect(definition.contract.permission.describe("explore:*")).toContain("explore:*");
	});
});

describe("delegate evidence: workflow record (task 4.6)", () => {
	it("captures a workflow evidence record naming the agent type and task", () => {
		const definition = createDelegateToolDefinition();
		const params = { agentType: "explore", task: "find the config loader" };
		const result = { content: [], details: undefined };
		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{ kind: "workflow", agentType: "explore", task: "find the config loader" },
		]);
	});
});

describe("delegate execution: entry point only, no child execution before Phase 5 (task 4.6)", () => {
	it("throws rather than silently pretending to delegate -- subagent spawning is not implemented in this phase", async () => {
		const definition = createDelegateToolDefinition();
		await expect(
			definition.execute("call-1", { agentType: "explore", task: "find the config loader" }),
		).rejects.toThrow(/not implemented|phase 5/i);
	});
});
