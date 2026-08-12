import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { PermissionSpec } from "../../src/core/tools/contract.ts";
import {
	PERMISSION_SOURCES,
	type PermissionRule,
	resolvePermission,
} from "../../src/core/permissions/rules.ts";

const exampleSchema = Type.Object({ path: Type.String() });

/** A minimal glob-free spec: ruleContent matches iff it equals params.path exactly. */
const exactSpec: PermissionSpec<typeof exampleSchema> = {
	defaultBehavior: "ask",
	matches: (ruleContent, params) => ruleContent === params.path,
	describe: (ruleContent) => `exact:${ruleContent}`,
	ruleForCall: (params) => params.path,
};

function rule(source: PermissionRule["source"], behavior: PermissionRule["behavior"], overrides: Partial<PermissionRule> = {}): PermissionRule {
	return { source, behavior, toolName: "read", ruleContent: "a.txt", ...overrides };
}

describe("resolvePermission — eight-source precedence", () => {
	it("falls back to the tool's own default when no rule matches", () => {
		const result = resolvePermission([], "read", exactSpec, { path: "a.txt" });
		expect(result).toEqual({ behavior: "ask" });
	});

	it("ignores a rule for a different tool", () => {
		const result = resolvePermission([rule("user", "allow", { toolName: "write" })], "read", exactSpec, {
			path: "a.txt",
		});
		expect(result.behavior).toBe("ask");
	});

	it("ignores a rule whose ruleContent does not match this call", () => {
		const result = resolvePermission([rule("user", "allow", { ruleContent: "b.txt" })], "read", exactSpec, {
			path: "a.txt",
		});
		expect(result.behavior).toBe("ask");
	});

	it("a rule with no ruleContent matches every call to that tool", () => {
		const result = resolvePermission([rule("user", "deny", { ruleContent: undefined })], "read", exactSpec, {
			path: "anything.txt",
		});
		expect(result.behavior).toBe("deny");
	});

	// The full declared order: policy > flag > local > project > user > cliArg > command > session.
	it.each(
		PERMISSION_SOURCES.flatMap((higher, i) =>
			PERMISSION_SOURCES.slice(i + 1).map((lower) => [higher, lower] as const),
		),
	)("a real conflict at %s beats %s", (higher, lower) => {
		const rules = [rule(lower, "deny"), rule(higher, "allow")];
		const result = resolvePermission(rules, "read", exactSpec, { path: "a.txt" });
		expect(result.behavior).toBe("allow");
		expect(result.rule?.source).toBe(higher);
	});

	it("the highest-precedence MATCHING rule wins regardless of behavior — deny does not automatically win", () => {
		// local (higher) allows; project (lower) denies. local must win even though
		// it is the more permissive behavior — precedence, not "safety", decides.
		const rules = [rule("project", "deny"), rule("local", "allow")];
		const result = resolvePermission(rules, "read", exactSpec, { path: "a.txt" });
		expect(result).toMatchObject({ behavior: "allow" });
	});

	it("a non-matching higher-precedence rule does not shadow a matching lower one", () => {
		const rules = [
			rule("policy", "deny", { ruleContent: "other.txt" }), // does not match this call
			rule("session", "allow"),
		];
		const result = resolvePermission(rules, "read", exactSpec, { path: "a.txt" });
		expect(result.behavior).toBe("allow");
		expect(result.rule?.source).toBe("session");
	});

	it("resolves ties within one source deterministically, independent of array order", () => {
		const specific = rule("user", "deny", { ruleContent: "a.txt" });
		const blanket = rule("user", "allow", { ruleContent: undefined });
		const forward = resolvePermission([blanket, specific], "read", exactSpec, { path: "a.txt" });
		const backward = resolvePermission([specific, blanket], "read", exactSpec, { path: "a.txt" });
		expect(forward).toEqual(backward);
		// More specific (has ruleContent) beats a blanket tool-wide rule at the same source.
		expect(forward.behavior).toBe("deny");
	});
});

describe("PermissionRule / precedence resolver holds no tool-specific logic", () => {
	it("never inspects ruleContent's grammar itself — only calls spec.matches", () => {
		let calls = 0;
		const countingSpec: PermissionSpec<typeof exampleSchema> = {
			...exactSpec,
			matches: (ruleContent, params) => {
				calls++;
				return ruleContent === params.path;
			},
		};
		resolvePermission([rule("user", "allow")], "read", countingSpec, { path: "a.txt" });
		expect(calls).toBeGreaterThan(0);
	});
});
