import { describe, expect, it } from "vitest";
import {
	ALL_CAPABILITIES,
	type ApexToolDefinition,
	UNCLASSIFIED,
} from "../../src/core/tools/contract.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

const CWD = "/workspace";

function registry(): Record<string, ApexToolDefinition> {
	return createAllToolDefinitions(CWD) as unknown as Record<string, ApexToolDefinition>;
}

/**
 * Representative parameters per tool, used to exercise invariant 5 across the whole
 * registry rather than tool-by-tool. Keyed by tool name so a newly added tool fails
 * this file loudly instead of being silently skipped.
 */
const REPRESENTATIVE_PARAMS: Record<string, unknown> = {
	read: { path: "src/index.ts" },
	write: { path: "src/generated.ts", content: "export const x = 1;\n" },
	edit: { path: "src/index.ts", edits: [{ oldText: "a", newText: "b" }] },
	grep: { pattern: "TODO", path: "src" },
	find: { pattern: "**/*.ts", path: "src" },
	ls: { path: "src" },
	bash: { command: "git status" },
	tool_schema: { name: "read" },
};

describe("tool contracts", () => {
	it("declares a contract with every sub-field on every registered tool (invariant 1)", () => {
		for (const [name, tool] of Object.entries(registry())) {
			expect(tool.contract, `${name} has no contract`).toBeDefined();
			expect(tool.contract.capabilities, `${name}.capabilities`).toBeInstanceOf(Set);
			expect(tool.contract.permission, `${name}.permission`).toBeDefined();
			expect(tool.contract.context, `${name}.context`).toBeDefined();
			expect(tool.contract.evidence, `${name}.evidence`).toBeDefined();

			expect(typeof tool.contract.permission.defaultBehavior, `${name}.defaultBehavior`).toBe("string");
			expect(typeof tool.contract.permission.matches, `${name}.matches`).toBe("function");
			expect(typeof tool.contract.permission.describe, `${name}.describe`).toBe("function");
			expect(typeof tool.contract.permission.ruleForCall, `${name}.ruleForCall`).toBe("function");
			expect(typeof tool.contract.context.resultRecoverable, `${name}.resultRecoverable`).toBe("boolean");
			expect(typeof tool.contract.context.deferSchema, `${name}.deferSchema`).toBe("boolean");
			expect(tool.contract.evidence.emits, `${name}.emits`).toBeInstanceOf(Set);
			expect(typeof tool.contract.evidence.capture, `${name}.capture`).toBe("function");
		}
	});

	it("covers exactly the registered tools, so a new tool cannot be silently omitted", () => {
		expect(Object.keys(registry()).sort()).toEqual(Object.keys(REPRESENTATIVE_PARAMS).sort());
	});

	it("defaults read-only tools to allow and mutating tools to ask", () => {
		const tools = registry();
		for (const name of ["read", "grep", "find", "ls"]) {
			expect(tools[name].contract.permission.defaultBehavior, name).toBe("allow");
		}
		for (const name of ["write", "edit", "bash"]) {
			expect(tools[name].contract.permission.defaultBehavior, name).toBe("ask");
		}
	});

	it("declares capabilities matching what each tool actually does", () => {
		const tools = registry();
		const expected: Record<string, string[]> = {
			read: ["fs.read"],
			grep: ["fs.read"],
			find: ["fs.read"],
			ls: ["fs.read"],
			write: ["fs.write"],
			edit: ["fs.read", "fs.write"],
			bash: ["exec"],
		};
		for (const [name, caps] of Object.entries(expected)) {
			expect([...tools[name].contract.capabilities].sort(), name).toEqual(caps.sort());
		}
	});

	it("holds matches(ruleForCall(p), p) across the registry (invariant 5)", () => {
		for (const [name, tool] of Object.entries(registry())) {
			const params = REPRESENTATIVE_PARAMS[name];
			const rule = tool.contract.permission.ruleForCall(params);
			if (rule === null) {
				// A null rule is a deliberate "this call is not generalizable". Assert it
				// is deliberate by requiring the tool to also refuse to match anything.
				expect(tool.contract.permission.matches("**", params), `${name} null-rule`).toBe(false);
				continue;
			}
			expect(tool.contract.permission.matches(rule, params), `${name} rule=${rule}`).toBe(true);
		}
	});

	it("renders a human-readable description for every tool's rule content", () => {
		for (const [name, tool] of Object.entries(registry())) {
			const described = tool.contract.permission.describe("src/**");
			expect(typeof described, name).toBe("string");
			expect(described.length, name).toBeGreaterThan(0);
		}
	});

	it("never generates a rule from one call that authorizes an unrelated path", () => {
		const tools = registry();
		const rule = tools.read.contract.permission.ruleForCall({ path: "src/index.ts" });
		expect(rule).not.toBeNull();
		expect(tools.read.contract.permission.matches(rule as string, { path: "/etc/shadow" })).toBe(false);
		expect(tools.read.contract.permission.matches(rule as string, { path: "src/other.ts" })).toBe(false);
	});
});

describe("UNCLASSIFIED", () => {
	it("is conservative on every axis for foreign tools that cannot supply a contract", () => {
		expect([...UNCLASSIFIED.capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
		expect(UNCLASSIFIED.permission.defaultBehavior).toBe("ask");
		expect(UNCLASSIFIED.context.resultRecoverable).toBe(false);
		expect(UNCLASSIFIED.context.deferSchema).toBe(false);
		expect(UNCLASSIFIED.evidence.emits.size).toBe(0);
		expect(UNCLASSIFIED.evidence.capture({}, { content: [] } as never)).toEqual([]);
	});

	it("matches only on exact arguments, never on a pattern", () => {
		const params = { command: "rm -rf /" };
		expect(UNCLASSIFIED.permission.matches("**", params)).toBe(false);
		expect(UNCLASSIFIED.permission.matches(JSON.stringify(params), params)).toBe(true);
	});

	it("generates no persistable rule, so a foreign tool cannot be permanently allowed by pattern", () => {
		expect(UNCLASSIFIED.permission.ruleForCall({ command: "x" })).toBe(JSON.stringify({ command: "x" }));
	});
});
