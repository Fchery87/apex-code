import { describe, expect, it } from "vitest";
import { createLspToolDefinition, type LspOperations } from "../../src/core/tools/lsp.ts";

const CWD = "/workspace";

const noopOperations: LspOperations = { request: async () => [] };

describe("lsp permission grammar (LSP.5)", () => {
	it("holds matches(ruleForCall(p), p) for definition/references/document_symbols calls (invariant 5)", () => {
		const definition = createLspToolDefinition(CWD, { operations: noopOperations });
		const calls = [
			{ operation: "definition" as const, path: "src/index.ts", line: 1, character: 1 },
			{ operation: "references" as const, path: "src/other.ts", line: 12, character: 4 },
			{ operation: "document_symbols" as const, path: "src/index.ts" },
		];
		for (const call of calls) {
			const rule = definition.contract.permission.ruleForCall(call);
			expect(rule, JSON.stringify(call)).not.toBeNull();
			expect(definition.contract.permission.matches(rule as string, call), JSON.stringify(call)).toBe(true);
		}
	});

	it("does not match a call it superficially resembles -- same tool, different path (negative case)", () => {
		const definition = createLspToolDefinition(CWD, { operations: noopOperations });
		const call = { operation: "definition" as const, path: "src/index.ts", line: 1, character: 1 };
		const rule = definition.contract.permission.ruleForCall(call);
		expect(rule).not.toBeNull();

		// Same operation/line/character, a different path -- the rule authorizes a path,
		// not "this exact call", so a different file must not match.
		expect(definition.contract.permission.matches(rule as string, { ...call, path: "src/unrelated.ts" })).toBe(false);
		// Also does not match a superficially similar path just outside the rule's scope.
		expect(definition.contract.permission.matches(rule as string, { ...call, path: "src/index.test.ts" })).toBe(
			false,
		);
	});

	it("never generalizes a rule from one call to authorize an unrelated path (mirrors read/grep's own guarantee)", () => {
		const definition = createLspToolDefinition(CWD, { operations: noopOperations });
		const rule = definition.contract.permission.ruleForCall({
			operation: "document_symbols",
			path: "src/index.ts",
		});
		expect(rule).not.toBeNull();
		expect(
			definition.contract.permission.matches(rule as string, { operation: "document_symbols", path: "/etc/shadow" }),
		).toBe(false);
	});
});
