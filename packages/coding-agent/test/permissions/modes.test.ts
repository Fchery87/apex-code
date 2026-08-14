import { describe, expect, it } from "vitest";
import { resolveWithMode } from "../../src/core/permissions/modes.ts";
import type { PermissionResolution, PermissionRule } from "../../src/core/permissions/rules.ts";
import type { Capability } from "../../src/core/tools/contract.ts";

function caps(...values: Capability[]): ReadonlySet<Capability> {
	return new Set(values);
}

function noRule(behavior: PermissionResolution["behavior"]): PermissionResolution {
	return { behavior };
}

function withRule(rule: PermissionRule): PermissionResolution {
	return { behavior: rule.behavior, rule };
}

const explicitDeny: PermissionRule = { source: "user", behavior: "deny", toolName: "write" };
const explicitAllow: PermissionRule = { source: "user", behavior: "allow", toolName: "bash" };

describe("resolveWithMode", () => {
	describe("default", () => {
		it("defers entirely to the rule resolution, untouched", () => {
			expect(resolveWithMode("default", noRule("ask"), caps("fs.write"))).toEqual(noRule("ask"));
			expect(resolveWithMode("default", withRule(explicitDeny), caps("fs.write"))).toEqual(withRule(explicitDeny));
		});
	});

	describe("plan", () => {
		it("denies a tool with fs.write capability, even past the tool's own allow default", () => {
			expect(resolveWithMode("plan", noRule("allow"), caps("fs.write"))).toEqual({ behavior: "deny" });
		});

		it("denies a tool with exec capability", () => {
			expect(resolveWithMode("plan", noRule("ask"), caps("exec"))).toEqual({ behavior: "deny" });
		});

		it("denies a tool with delegate capability", () => {
			expect(resolveWithMode("plan", noRule("allow"), caps("delegate"))).toEqual({ behavior: "deny" });
		});

		it("allows a pure fs.read tool, deferring to its own resolution", () => {
			expect(resolveWithMode("plan", noRule("allow"), caps("fs.read"))).toEqual(noRule("allow"));
		});

		it("allows a state-capability tool (e.g. todo_write) -- plan mode narrows the floor to fs.write/exec/delegate only", () => {
			expect(resolveWithMode("plan", noRule("allow"), caps("state"))).toEqual(noRule("allow"));
		});

		it("is a hard safety floor: overrides even an explicit allow rule for a mutating capability", () => {
			expect(resolveWithMode("plan", withRule(explicitAllow), caps("exec"))).toEqual({ behavior: "deny" });
		});

		it("remains a hard safety floor over a policy allow", () => {
			const policyAllow: PermissionRule = { source: "policy", behavior: "allow", toolName: "bash" };
			expect(resolveWithMode("plan", withRule(policyAllow), caps("exec"))).toEqual({ behavior: "deny" });
		});
	});

	describe("acceptEdits", () => {
		it("auto-allows a pure edit-shaped tool (fs.write, no exec/net/delegate/state) whose default was ask", () => {
			expect(resolveWithMode("acceptEdits", noRule("ask"), caps("fs.write"))).toEqual({ behavior: "allow" });
			expect(resolveWithMode("acceptEdits", noRule("ask"), caps("fs.read", "fs.write"))).toEqual({
				behavior: "allow",
			});
		});

		it("leaves an exec-capable tool asking — it never becomes edit-shaped by name", () => {
			expect(resolveWithMode("acceptEdits", noRule("ask"), caps("exec"))).toEqual(noRule("ask"));
		});

		it("respects an explicit rule rather than overriding it", () => {
			expect(resolveWithMode("acceptEdits", withRule(explicitDeny), caps("fs.write"))).toEqual(
				withRule(explicitDeny),
			);
		});
	});

	describe("bypassPermissions", () => {
		it("allows everything, including a capability plan mode would deny", () => {
			expect(resolveWithMode("bypassPermissions", noRule("ask"), caps("exec"))).toEqual({ behavior: "allow" });
		});

		it("allows even past an explicit deny rule", () => {
			expect(resolveWithMode("bypassPermissions", withRule(explicitDeny), caps("fs.write"))).toEqual({
				behavior: "allow",
			});
		});
		it("does not override a matching administrator policy rule", () => {
			const policyDeny: PermissionRule = { source: "policy", behavior: "deny", toolName: "bash" };
			expect(resolveWithMode("bypassPermissions", withRule(policyDeny), caps("exec"))).toEqual(withRule(policyDeny));
		});
	});

	describe("dontAsk", () => {
		it("converts a default ask into deny", () => {
			expect(resolveWithMode("dontAsk", noRule("ask"), caps("fs.write"))).toEqual({ behavior: "deny" });
		});

		it("never prompts: the resulting behavior is never ask", () => {
			for (const capability of ["fs.read", "fs.write", "exec", "net", "delegate", "ui", "state"] as Capability[]) {
				const result = resolveWithMode("dontAsk", noRule("ask"), caps(capability));
				expect(result.behavior).not.toBe("ask");
			}
		});

		it("leaves a non-ask resolution (allow/deny) untouched", () => {
			expect(resolveWithMode("dontAsk", noRule("allow"), caps("fs.read"))).toEqual(noRule("allow"));
			expect(resolveWithMode("dontAsk", withRule(explicitDeny), caps("fs.write"))).toEqual(withRule(explicitDeny));
		});
	});

	it("never denies an empty-capability tool (the schema loader's shape) under any mode's floor", () => {
		// tool_schema declares an empty capability set so it stays callable to load the
		// schema of a deferred tool no matter which mode -- including plan -- is active.
		for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"] as const) {
			expect(resolveWithMode(mode, noRule("allow"), caps())).toEqual(noRule("allow"));
		}
	});

	it("never references a tool by name — only by declared capability", () => {
		// A hypothetical future tool with the same shape as bash must behave
		// identically under every mode, proving no hardcoded tool-name branch exists.
		const futureExecTool = caps("exec");
		for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"] as const) {
			expect(resolveWithMode(mode, noRule("ask"), futureExecTool)).toEqual(
				resolveWithMode(mode, noRule("ask"), caps("exec")),
			);
		}
	});
});
