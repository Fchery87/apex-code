import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_MAX_OUTPUT_LINES,
	DEFAULT_TIMEOUT_MS,
	loadPolicyConfiguration,
	type PolicyLoadError,
} from "../src/core/policy-loader.ts";

/**
 * VF.2 (spec 2026-09-01-configured-verification-and-formatting.md § 1):
 * strict loading of policy settings into the canonical CommandPolicy
 * projection. The loader is the ONE projection from settings to policies —
 * nothing else re-derives defaults, bounds, or trust stamps (ADR 0010's
 * one-projection rule applied to configured commands). Any validation error
 * in a source drops that source entirely: half-applied policies are worse
 * than absent ones because they look configured while running differently.
 */

const validVerification = {
	id: "typecheck",
	executable: "npx",
	argv: ["tsc", "--noEmit"],
	blocksCompletion: true,
};

const validFormatter = {
	id: "format",
	executable: "npx",
	argv: ["biome", "format", "--write"],
	declaredPaths: ["src/**/*.ts"],
	permission: "allow",
};

function userPolicies(policies: unknown) {
	return loadPolicyConfiguration({
		globalSettings: policies as never,
		projectSettings: undefined,
		projectTrusted: false,
	});
}

describe("policy loader: strict source validation", () => {
	it("projects an empty snapshot when nothing is configured", () => {
		const result = loadPolicyConfiguration({
			globalSettings: undefined,
			projectSettings: undefined,
			projectTrusted: false,
		});
		expect(result).toEqual({ verification: [], formatter: [], errors: [] });
	});

	it("stamps canonical defaults onto a valid verification policy", () => {
		const result = userPolicies({ schemaVersion: 1, verification: [validVerification] });
		expect(result.errors).toEqual([]);
		expect(result.verification).toEqual([
			{
				id: "typecheck",
				executable: "npx",
				argv: ["tsc", "--noEmit"],
				cwd: "workspace",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
				maxOutputLines: DEFAULT_MAX_OUTPUT_LINES,
				shell: false,
				permission: "ask",
				trustedSource: "user",
				kind: "verification",
				blocksCompletion: true,
			},
		]);
		expect(result.formatter).toEqual([]);
	});

	it("stamps kind and mutatesFiles onto a valid formatter policy", () => {
		const result = userPolicies({ schemaVersion: 1, formatter: [validFormatter] });
		expect(result.errors).toEqual([]);
		expect(result.formatter).toEqual([
			{
				id: "format",
				executable: "npx",
				argv: ["biome", "format", "--write"],
				cwd: "workspace",
				timeoutMs: DEFAULT_TIMEOUT_MS,
				maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
				maxOutputLines: DEFAULT_MAX_OUTPUT_LINES,
				shell: false,
				permission: "allow",
				trustedSource: "user",
				kind: "formatter",
				mutatesFiles: true,
				declaredPaths: ["src/**/*.ts"],
			},
		]);
	});

	it("rejects an unknown schemaVersion as a source-level error", () => {
		const result = userPolicies({ schemaVersion: 2, verification: [validVerification] });
		expect(result.verification).toEqual([]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].source).toBe("user");
		expect(result.errors[0].policyId).toBeUndefined();
	});

	it("rejects empty argv, non-string argv entries, and an empty executable", () => {
		for (const broken of [
			{ ...validVerification, argv: [] },
			{ ...validVerification, argv: ["tsc", 3] },
			{ ...validVerification, executable: "" },
		]) {
			const result = userPolicies({ schemaVersion: 1, verification: [broken] });
			expect(result.verification).toEqual([]);
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});

	it("rejects shell true outright and accepts literal false", () => {
		const refused = userPolicies({ schemaVersion: 1, verification: [{ ...validVerification, shell: true }] });
		expect(refused.verification).toEqual([]);
		expect(refused.errors[0].message).toContain("shell");

		const accepted = userPolicies({ schemaVersion: 1, verification: [{ ...validVerification, shell: false }] });
		expect(accepted.errors).toEqual([]);
		expect(accepted.verification[0].shell).toBe(false);
	});

	it("enforces positive numeric bounds with hard caps", () => {
		for (const broken of [
			{ ...validVerification, timeoutMs: 0 },
			{ ...validVerification, timeoutMs: -5 },
			{ ...validVerification, timeoutMs: 600_001 },
			{ ...validVerification, maxOutputBytes: 2_097_152 },
			{ ...validVerification, maxOutputLines: 0 },
		]) {
			const result = userPolicies({ schemaVersion: 1, verification: [broken] });
			expect(result.verification).toEqual([]);
			expect(result.errors.length).toBe(1);
		}

		const bounded = userPolicies({
			schemaVersion: 1,
			verification: [{ ...validVerification, timeoutMs: 30_000, maxOutputBytes: 65_536, maxOutputLines: 100 }],
		});
		expect(bounded.errors).toEqual([]);
		expect(bounded.verification[0].timeoutMs).toBe(30_000);
	});

	it("refuses path traversal and absolute cwd at load time", () => {
		for (const broken of [
			{ ...validVerification, pathScope: ["src/../.."] },
			{ ...validVerification, cwd: "../../elsewhere" },
			{ ...validVerification, cwd: "/etc" },
			{ ...validFormatter, declaredPaths: ["../outside/**/*.ts"] },
		]) {
			const policies: Record<string, unknown> = { schemaVersion: 1 };
			if ("declaredPaths" in broken) {
				policies.formatter = [broken];
			} else {
				policies.verification = [broken];
			}
			const result = userPolicies(policies);
			expect(result.errors.length).toBe(1);
			expect(result.verification).toEqual([]);
			expect(result.formatter).toEqual([]);
		}
	});

	it("rejects a formatter without declared paths", () => {
		const { declaredPaths: _dropped, ...noPaths } = validFormatter;
		const result = userPolicies({ schemaVersion: 1, formatter: [noPaths] });
		expect(result.formatter).toEqual([]);
		expect(result.errors.length).toBe(1);
	});

	it("rejects unknown fields so typos cannot silently widen a policy", () => {
		const result = userPolicies({ schemaVersion: 1, verification: [{ ...validVerification, timeouMs: 1000 }] });
		expect(result.verification).toEqual([]);
		expect(result.errors[0].message).toContain("timeouMs");
	});

	it("rejects duplicate IDs across kinds within one source", () => {
		const result = userPolicies({
			schemaVersion: 1,
			verification: [validVerification],
			formatter: [{ ...validFormatter, id: "typecheck" }],
		});
		expect(result.verification).toEqual([]);
		expect(result.formatter).toEqual([]);
		expect(result.errors[0].policyId).toBe("typecheck");
	});

	it("drops a whole source when one entry is malformed, keeping the other source intact", () => {
		const result = loadPolicyConfiguration({
			globalSettings: { schemaVersion: 1, verification: [validVerification] },
			projectSettings: {
				schemaVersion: 1,
				verification: [validVerification, { ...validVerification, id: "" }],
			},
			projectTrusted: true,
		});
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].source).toBe("project");
		expect(result.verification.map((policy) => [policy.id, policy.trustedSource])).toEqual([["typecheck", "user"]]);
	});
});

describe("policy loader: trust, precedence, and ceiling projection", () => {
	it("ignores project policies entirely when the project is not trusted", () => {
		const result = loadPolicyConfiguration({
			globalSettings: { schemaVersion: 1, verification: [validVerification] },
			projectSettings: { schemaVersion: 1, formatter: [validFormatter] },
			projectTrusted: false,
		});
		expect(result.errors).toEqual([]);
		expect(result.verification.map((policy) => policy.trustedSource)).toEqual(["user"]);
		expect(result.formatter).toEqual([]);
	});

	it("lets a trusted project policy replace the user policy with the same ID", () => {
		const result = loadPolicyConfiguration({
			globalSettings: { schemaVersion: 1, verification: [validVerification] },
			projectSettings: {
				schemaVersion: 1,
				verification: [{ ...validVerification, argv: ["tsc", "--noEmit", "--strict"], permission: "deny" }],
			},
			projectTrusted: true,
		});
		expect(result.errors).toEqual([]);
		expect(result.verification).toHaveLength(1);
		expect(result.verification[0].trustedSource).toBe("project");
		expect(result.verification[0].argv).toEqual(["tsc", "--noEmit", "--strict"]);
		expect(result.verification[0].permission).toBe("deny");
	});

	it("keeps distinct user and project IDs side by side", () => {
		const result = loadPolicyConfiguration({
			globalSettings: { schemaVersion: 1, verification: [validVerification] },
			projectSettings: { schemaVersion: 1, verification: [{ ...validVerification, id: "lint" }] },
			projectTrusted: true,
		});
		expect(result.errors).toEqual([]);
		expect(result.verification.map((policy) => [policy.id, policy.trustedSource])).toEqual([
			["typecheck", "user"],
			["lint", "project"],
		]);
	});

	it("preserves a denied policy verbatim instead of upgrading it", () => {
		const result = userPolicies({
			schemaVersion: 1,
			verification: [{ ...validVerification, permission: "deny" }],
		});
		expect(result.errors).toEqual([]);
		expect(result.verification[0].permission).toBe("deny");
	});

	it("is a pure projection: identical inputs load to a deep-equal snapshot", () => {
		const input = {
			globalSettings: { schemaVersion: 1, verification: [validVerification], formatter: [validFormatter] },
			projectSettings: { schemaVersion: 1, formatter: [validFormatter] },
			projectTrusted: true,
		};
		const first = loadPolicyConfiguration(input);
		const second = loadPolicyConfiguration(input);
		expect(first).toEqual(second);
		expect(JSON.parse(JSON.stringify(first))).toEqual(first);
	});

	it("surfaces errors as structured values, never throws", () => {
		const result = loadPolicyConfiguration({
			globalSettings: { schemaVersion: "one" } as never,
			projectSettings: { schemaVersion: 1, verification: [{ ...validVerification, argv: [] }] },
			projectTrusted: true,
		});
		const errors: PolicyLoadError[] = result.errors;
		expect(errors.map((error) => error.source)).toEqual(["user", "project"]);
		expect(result.verification).toEqual([]);
	});
});
