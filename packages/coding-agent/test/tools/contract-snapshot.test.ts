import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES } from "../../src/core/tools/contract.ts";
import { buildToolContractSnapshot } from "../../src/core/tools/contract-snapshot.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

function registry() {
	return Object.values(createAllToolDefinitions(process.cwd()));
}

describe("buildToolContractSnapshot", () => {
	it("returns one entry per tool, keyed by name", () => {
		const tools = registry();
		const snapshot = buildToolContractSnapshot(tools);

		expect(snapshot.map((entry) => entry.name).sort()).toEqual(tools.map((tool) => tool.name).sort());
	});

	it("is a pure read: two calls agree and nothing is mutated", () => {
		const tools = registry();
		const before = JSON.stringify(tools.map((tool) => tool.name));

		expect(buildToolContractSnapshot(tools)).toEqual(buildToolContractSnapshot(tools));
		expect(JSON.stringify(tools.map((tool) => tool.name))).toBe(before);
	});

	it("projects the four contract axes for a declared tool", () => {
		const read = buildToolContractSnapshot(registry()).find((entry) => entry.name === "read");

		expect(read?.unclassified).toBe(false);
		expect(read?.capabilities).toContain("fs.read");
		expect(read?.permission.defaultBehavior).toBeTypeOf("string");
		expect(read?.context.resultRecoverable).toBeTypeOf("boolean");
		expect(read?.context.deferSchema).toBeTypeOf("boolean");
		expect(Array.isArray(read?.evidence.emits)).toBe(true);
	});

	it("reports a tool registered without a contract as unclassified, with the conservative fallback", () => {
		// ADR 0010: foreign tools are "neither rejected nor silently defaulted". A
		// conservative default nobody can see is indistinguishable from a bug, so the
		// fallback and the visibility are asserted together.
		const foreign = { name: "foreign", description: "no contract", parameters: {} };
		const entry = buildToolContractSnapshot([foreign as never])[0];

		expect(entry.unclassified).toBe(true);
		expect(entry.permission.defaultBehavior).toBe("ask");
		expect([...entry.capabilities].sort()).toEqual([...ALL_CAPABILITIES].sort());
		expect(entry.context.resultRecoverable).toBe(false);
	});
});

describe("ADR 0010 drift invariant", () => {
	it("every tool in the default registry declares a contract", () => {
		const undeclared = buildToolContractSnapshot(registry())
			.filter((entry) => entry.unclassified)
			.map((entry) => entry.name);

		expect(undeclared).toEqual([]);
	});

	it("every declared tool answers all four axes", () => {
		for (const entry of buildToolContractSnapshot(registry())) {
			expect(entry.capabilities, entry.name).toBeDefined();
			expect(entry.permission.defaultBehavior, entry.name).toBeDefined();
			expect(entry.context, entry.name).toBeDefined();
			expect(entry.evidence.emits, entry.name).toBeDefined();
		}
	});

	// ADR 0010's invariant 5 -- `matches(ruleForCall(p), p)` across the whole registry --
	// is deliberately not asserted here. It needs a valid sample `params` per tool, and
	// every tool's grammar reads different fields, so a shared stub exercises none of them
	// and a hand-written table for nineteen tools rots faster than it catches anything. The
	// spec records it as owed rather than pretending a passing stub covers it.
});
