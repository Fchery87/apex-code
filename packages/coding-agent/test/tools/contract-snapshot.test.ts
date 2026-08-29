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

/*
 * The registry-wide ADR 0010 invariants are not re-asserted here.
 *
 * `test/permissions/contract.test.ts` already owns them, and has since before this
 * projection existed: invariant 1 (every registered tool declares a contract with every
 * sub-field), invariant 4, and invariant 5's `matches(ruleForCall(p), p)` across the whole
 * registry, driven by a `REPRESENTATIVE_PARAMS` table keyed so an unlisted tool fails
 * loudly rather than being skipped.
 *
 * This file covers the projection itself -- that it reports one entry per tool, reads
 * rather than mutates, carries the four axes through, and surfaces a foreign tool as
 * unclassified. Asserting the registry invariants a second time here would be the
 * duplicate classification ADR 0010 exists to prevent, wearing a test's clothes.
 */
