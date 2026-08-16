import { describe, expect, test } from "vitest";
import { CredentialPool, type CredentialPoolEntry, createCredentialIdentity } from "../src/core/credential-pool.ts";

function entry(id: string, providerId = "test-provider"): CredentialPoolEntry {
	return { identity: createCredentialIdentity(id), providerId };
}

describe("CredentialPool", () => {
	test("rotates eligible opaque identities deterministically without selecting one twice per turn", () => {
		const pool = new CredentialPool({
			entries: [entry("primary"), entry("secondary")],
			now: () => 100,
		});
		const attempted = new Set<ReturnType<typeof createCredentialIdentity>>();

		const first = pool.select({ providerId: "test-provider", attempted });
		expect(first?.identity).toBe(createCredentialIdentity("primary"));
		attempted.add(first!.identity);

		const second = pool.select({ providerId: "test-provider", attempted });
		expect(second?.identity).toBe(createCredentialIdentity("secondary"));
		attempted.add(second!.identity);

		expect(pool.select({ providerId: "test-provider", attempted })).toBeUndefined();
	});

	test("excludes a rate-limited identity until its cooldown expires", () => {
		let now = 100;
		const primary = createCredentialIdentity("primary");
		const pool = new CredentialPool({
			entries: [entry("primary"), entry("secondary")],
			now: () => now,
			cooldownMs: 1_000,
		});

		pool.recordFailure({ identity: primary, kind: "rate_limited" });
		expect(pool.select({ providerId: "test-provider", attempted: new Set() })?.identity).toBe(
			createCredentialIdentity("secondary"),
		);

		now += 1_000;
		expect(pool.select({ providerId: "test-provider", attempted: new Set() })?.identity).toBe(primary);
	});

	test("does not expose a credential secret through its snapshot", () => {
		const pool = new CredentialPool({ entries: [entry("primary")] });

		expect(JSON.stringify(pool.snapshot())).not.toContain("credential-secret-sentinel");
		expect(pool.snapshot()).toEqual([
			{
				identity: createCredentialIdentity("primary"),
				providerId: "test-provider",
				blockedUntil: undefined,
			},
		]);
	});
	test("grants one refresh lease per identity until it expires or its owner releases it", () => {
		let now = 100;
		const identity = createCredentialIdentity("primary");
		const pool = new CredentialPool({ entries: [entry("primary")], now: () => now });

		expect(pool.acquireRefreshLease({ identity, owner: "first", durationMs: 50 })).toEqual({
			identity,
			owner: "first",
			expiresAt: 150,
		});
		expect(pool.acquireRefreshLease({ identity, owner: "second", durationMs: 50 })).toBeUndefined();
		expect(pool.releaseRefreshLease({ identity, owner: "second" })).toBe(false);
		expect(pool.releaseRefreshLease({ identity, owner: "first" })).toBe(true);
		expect(pool.acquireRefreshLease({ identity, owner: "second", durationMs: 50 })).toEqual({
			identity,
			owner: "second",
			expiresAt: 150,
		});

		now = 151;
		expect(pool.acquireRefreshLease({ identity, owner: "third", durationMs: 50 })).toEqual({
			identity,
			owner: "third",
			expiresAt: 201,
		});
	});

	test("rejects duplicate identities rather than making a credential selection ambiguous", () => {
		expect(() => new CredentialPool({ entries: [entry("primary"), entry("primary")] })).toThrow(
			'Duplicate credential identity "primary"',
		);
	});
});
