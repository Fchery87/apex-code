import { describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { createDelegateToolDefinition } from "../../src/core/tools/delegate.ts";
import type { Capability } from "../../src/core/tools/contract.ts";

/** A runtime fixture that never resolves any agent -- enough to exercise the contract shape without a real child. */
function inertRuntime(overrides: Partial<DelegationRuntimeOptions> = {}): DelegationRuntimeOptions {
	return {
		resolveAgent: () => undefined,
		getParentCapabilities: () => new Set<Capability>(),
		getToolCapabilities: () => undefined,
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		buildChildSession: vi.fn(async () => {
			throw new Error("buildChildSession should not be called by the inert fixture");
		}),
		...overrides,
	};
}

describe("delegate contract (task 4.6: entry point only)", () => {
	it("declares the delegate capability, ask default, deferred schema, and workflow evidence", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		expect([...definition.contract.capabilities]).toEqual(["delegate"]);
		expect(definition.contract.permission.defaultBehavior).toBe("ask");
		expect(definition.contract.context.deferSchema).toBe(true);
		expect([...definition.contract.evidence.emits]).toEqual(["workflow"]);
	});
});

describe("delegate rule grammar: agent-type glob (task 4.6)", () => {
	it("ruleForCall generates the exact agent type of the call, never a pattern the tool did not generate itself", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		const rule = definition.contract.permission.ruleForCall({ agentType: "explore", task: "find the config loader" });
		expect(rule).toBe("explore");
	});

	it("an auto-generated rule matches only the exact agent type it came from", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		const rule = definition.contract.permission.ruleForCall({ agentType: "explore", task: "x" }) as string;
		expect(definition.contract.permission.matches(rule, { agentType: "explore", task: "anything" })).toBe(true);
		expect(definition.contract.permission.matches(rule, { agentType: "general-purpose", task: "x" })).toBe(false);
	});

	it("a hand-authored agent-type glob (explore:*) matches namespaced agent types under that prefix", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		const glob = "explore:*";
		expect(definition.contract.permission.matches(glob, { agentType: "explore:quick", task: "x" })).toBe(true);
		expect(definition.contract.permission.matches(glob, { agentType: "explore:thorough", task: "x" })).toBe(true);
		expect(definition.contract.permission.matches(glob, { agentType: "general-purpose", task: "x" })).toBe(false);
	});

	it("renders a human-readable description of the rule content", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		expect(definition.contract.permission.describe("explore:*")).toContain("explore:*");
	});
});

describe("delegate evidence: workflow record (task 4.6)", () => {
	it("captures a workflow evidence record naming the agent type and task", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		const params = { agentType: "explore", task: "find the config loader" };
		const result = { content: [], details: undefined };
		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{ kind: "workflow", agentType: "explore", task: "find the config loader" },
		]);
	});
});

describe("delegate execution: runs a real child through the injected runtime (task 5.2)", () => {
	it("returns the child's output as the tool result on success", async () => {
		const runtime = inertRuntime({
			resolveAgent: (agentType) =>
				agentType === "explore" ? { name: "explore", description: "recon", tools: [], systemPrompt: "" } : undefined,
			getParentCapabilities: () => new Set<Capability>(["delegate"]),
			buildChildSession: vi.fn(async () => ({
				run: async (task: string) => ({ output: `explored: ${task}` }),
				dispose: () => {},
			})),
		});
		const definition = createDelegateToolDefinition(runtime);

		const result = await definition.execute("call-1", { agentType: "explore", task: "find the config loader" });

		expect(result.content).toEqual([{ type: "text", text: "explored: find the config loader" }]);
		expect(result.details).toEqual({ agentType: "explore", task: "find the config loader", output: "explored: find the config loader", handle: undefined });
	});

	it("keeps the established agent-type glob grammar for an earlier delegate rule", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		expect(definition.contract.permission.matches("explore:*", { agentType: "explore:quick", task: "x" })).toBe(true);
	});

	it("requires retrieval to name the originating agent type", () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		const params = { agentType: "explore:quick", handle: "h" };
		expect(definition.contract.permission.matches("explore:*", params)).toBe(true);
		expect(definition.contract.permission.matches("worker", params)).toBe(false);
	});

	it("throws (a model-readable isError result once caught by the agent loop) for an unresolvable agent type", async () => {
		const definition = createDelegateToolDefinition(inertRuntime());
		await expect(
			definition.execute("call-1", { agentType: "explore", task: "find the config loader" }),
		).rejects.toThrow(/unknown agent type/i);
	});
});
