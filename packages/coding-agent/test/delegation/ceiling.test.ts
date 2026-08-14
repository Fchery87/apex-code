import { describe, expect, it } from "vitest";
import { computeCapabilityCeiling } from "../../src/core/delegation/ceiling.ts";
import { ALL_CAPABILITIES, type Capability } from "../../src/core/tools/contract.ts";

function caps(...values: Capability[]): ReadonlySet<Capability> {
	return new Set(values);
}

describe("computeCapabilityCeiling", () => {
	it("admits a requested set that is a subset of the parent's", () => {
		const result = computeCapabilityCeiling(caps("fs.read", "fs.write"), caps("fs.read"));
		expect(result).toEqual({ allowed: true, capabilities: caps("fs.read") });
	});

	it("admits the exact requested set, not the parent's wider set", () => {
		const result = computeCapabilityCeiling(caps("fs.read", "fs.write", "net"), caps("fs.read"));
		expect(result.allowed).toBe(true);
		if (result.allowed) {
			expect(result.capabilities).toEqual(caps("fs.read"));
		}
	});

	it("refuses a requested capability the parent does not hold, naming it", () => {
		const result = computeCapabilityCeiling(caps("fs.read"), caps("fs.read", "net"));
		expect(result).toEqual({ allowed: false, deniedCapability: "net" });
	});

	it("expands a parent holding exec to the full capability set (contracts.md §1.1)", () => {
		const result = computeCapabilityCeiling(caps("exec"), caps("fs.write", "net", "delegate"));
		expect(result.allowed).toBe(true);
		if (result.allowed) {
			expect(result.capabilities).toEqual(caps("fs.write", "net", "delegate"));
		}
	});

	it("admits a request for every capability when the parent holds exec", () => {
		const result = computeCapabilityCeiling(caps("exec"), ALL_CAPABILITIES);
		expect(result.allowed).toBe(true);
	});

	it("does not let exec itself bypass -- a parent without exec cannot delegate exec", () => {
		const result = computeCapabilityCeiling(caps("fs.read", "fs.write"), caps("exec"));
		expect(result).toEqual({ allowed: false, deniedCapability: "exec" });
	});

	it("admits an empty request against an empty parent", () => {
		const result = computeCapabilityCeiling(caps(), caps());
		expect(result).toEqual({ allowed: true, capabilities: caps() });
	});

	it("refuses any nonempty request against an empty parent", () => {
		const result = computeCapabilityCeiling(caps(), caps("fs.read"));
		expect(result).toEqual({ allowed: false, deniedCapability: "fs.read" });
	});

	it("refuses on the first capability not covered, deterministically, when multiple are missing", () => {
		// Set iteration order is insertion order -- "net" was requested before "delegate".
		const result = computeCapabilityCeiling(caps("fs.read"), caps("net", "delegate"));
		expect(result).toEqual({ allowed: false, deniedCapability: "net" });
	});
});
