import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionResponder } from "../../src/core/permissions/responder.ts";
import { DerivedPermissionRuleStore, FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { type ApexToolDefinition, UNCLASSIFIED } from "../../src/core/tools/contract.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "apex-derived-store-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

function registry(): Record<string, ApexToolDefinition> {
	return createAllToolDefinitions(scratch) as unknown as Record<string, ApexToolDefinition>;
}

function getContract(toolName: string) {
	return (registry()[toolName]?.contract) as ApexToolDefinition["contract"] | undefined;
}

function newParentStore(): FilePermissionRuleStore {
	return new FilePermissionRuleStore({
		cwd: join(scratch, "project"),
		agentDir: join(scratch, "agent"),
		policyPath: join(scratch, "missing-policy.json"),
	});
}

describe("DerivedPermissionRuleStore", () => {
	it("sees a session-source rule the parent already holds (a human's prior 'always allow')", async () => {
		const parent = newParentStore();
		// delegate defaults to "ask"; a session-source deny rule must block it in the child.
		await parent.apply({
			type: "addRules",
			destination: "session",
			rules: [{ toolName: "delegate", behavior: "deny", ruleContent: "explore" }],
		});

		const child = new DerivedPermissionRuleStore({ parent });
		const decision = await evaluateToolCall(
			"delegate",
			{ agentType: "explore", task: "find the config loader" },
			{ getContract, store: child, getMode: () => "default" },
		);

		expect(decision.block).toBe(true);
	});

	it("sees every other live rule source the parent holds too, not only session", async () => {
		const parent = newParentStore();
		await parent.apply({
			type: "addRules",
			destination: "project",
			rules: [{ toolName: "delegate", behavior: "allow", ruleContent: "explore" }],
		});

		const child = new DerivedPermissionRuleStore({ parent });
		const decision = await evaluateToolCall(
			"delegate",
			{ agentType: "explore", task: "find the config loader" },
			{ getContract, store: child, getMode: () => "default" },
		);

		expect(decision.block).toBe(false);
	});

	it("does not let a rule persisted inside the child widen the parent (ADR 0008)", async () => {
		const parent = newParentStore();
		const child = new DerivedPermissionRuleStore({ parent });
		const alwaysAllow: PermissionResponder = { ask: async () => ({ allow: true, persist: true }) };

		const decision = await evaluateToolCall(
			"delegate",
			{ agentType: "explore", task: "find the config loader" },
			{ getContract, store: child, getMode: () => "default", responder: alwaysAllow },
		);
		expect(decision.block).toBe(false);

		// The child's own store now has the persisted rule...
		const childSnapshot = await child.snapshot();
		expect(childSnapshot.rules).toContainEqual(
			expect.objectContaining({ toolName: "delegate", source: "session", ruleContent: "explore" }),
		);

		// ...but the parent's snapshot -- taken independently, after the child ran -- does not.
		const parentSnapshot = await parent.snapshot();
		expect(parentSnapshot.rules).not.toContainEqual(
			expect.objectContaining({ toolName: "delegate", source: "session" }),
		);
	});

	it("rejects an attempt to persist to a file-backed source -- runtime-only by construction", async () => {
		const parent = newParentStore();
		const child = new DerivedPermissionRuleStore({ parent });

		await expect(
			child.apply({
				type: "addRules",
				destination: "project",
				rules: [{ toolName: "delegate", behavior: "allow", ruleContent: "explore" }],
			}),
		).rejects.toThrow();

		// The parent's real project-scope file is untouched.
		const parentSnapshot = await parent.snapshot();
		expect(parentSnapshot.rules).toEqual([]);
	});

	it("merges the parent's runtime-only sources (flag/cliArg) too, since they never touch disk either", async () => {
		const parent = new FilePermissionRuleStore({
			cwd: join(scratch, "project2"),
			agentDir: join(scratch, "agent2"),
			policyPath: join(scratch, "missing-policy2.json"),
			initialRules: [{ source: "cliArg", toolName: "delegate", behavior: "deny", ruleContent: "explore" }],
		});
		const child = new DerivedPermissionRuleStore({ parent });

		const decision = await evaluateToolCall(
			"delegate",
			{ agentType: "explore", task: "find the config loader" },
			{ getContract, store: child, getMode: () => "default" },
		);
		expect(decision.block).toBe(true);
	});

	it("keeps a bash-holding parent's inherited rule restriction in force for the child", async () => {
		const parent = newParentStore();
		await parent.apply({
			type: "addRules", destination: "session", rules: [{ toolName: "bash", behavior: "deny", ruleContent: "rm *" }],
		});
		const child = new DerivedPermissionRuleStore({ parent });
		const decision = await evaluateToolCall("bash", { command: "rm generated.txt" }, {
			getContract, store: child, getMode: () => "default",
		});
		expect(decision.block).toBe(true);
	});

	it("never gets a full-registry contract lookup wrong for an unclassified tool", () => {
		// Sanity check the fixture itself isn't silently degrading to UNCLASSIFIED.
		expect(getContract("delegate")).not.toEqual(UNCLASSIFIED);
	});
});
