/** Non-secret credential selection state for a single process. */

export type CredentialIdentity = string & { readonly __brand: "CredentialIdentity" };

export function createCredentialIdentity(value: string): CredentialIdentity {
	if (!value.trim()) throw new Error("Credential identity must not be empty");
	return value as CredentialIdentity;
}

export interface CredentialPoolEntry {
	identity: CredentialIdentity;
	providerId: string;
}

export type CredentialFailureKind = "rate_limited" | "blocked" | "temporary";

export interface CredentialPoolOptions {
	entries: readonly CredentialPoolEntry[];
	now?: () => number;
	cooldownMs?: number;
}

export interface CredentialPoolSelection {
	identity: CredentialIdentity;
	providerId: string;
}

export interface CredentialPoolSnapshotEntry {
	identity: CredentialIdentity;
	providerId: string;
	blockedUntil: number | undefined;
}

export interface CredentialRefreshLease {
	identity: CredentialIdentity;
	owner: string;
	expiresAt: number;
}

export class CredentialPool {
	private readonly entries: readonly CredentialPoolEntry[];
	private readonly now: () => number;
	private readonly cooldownMs: number;
	private readonly blockedUntilByIdentity = new Map<CredentialIdentity, number>();
	private readonly refreshLeaseByIdentity = new Map<CredentialIdentity, CredentialRefreshLease>();
	private nextIndex = 0;

	constructor({ entries, now = Date.now, cooldownMs = 60_000 }: CredentialPoolOptions) {
		const seen = new Set<CredentialIdentity>();
		for (const entry of entries) {
			if (seen.has(entry.identity)) {
				throw new Error(`Duplicate credential identity "${entry.identity}"`);
			}
			seen.add(entry.identity);
		}
		this.entries = entries;
		this.now = now;
		this.cooldownMs = cooldownMs;
	}

	select({
		providerId,
		attempted,
	}: {
		providerId: string;
		attempted: ReadonlySet<CredentialIdentity>;
	}): CredentialPoolSelection | undefined {
		if (this.entries.length === 0) return undefined;
		const now = this.now();
		for (let offset = 0; offset < this.entries.length; offset++) {
			const index = (this.nextIndex + offset) % this.entries.length;
			const entry = this.entries[index];
			const blockedUntil = this.blockedUntilByIdentity.get(entry.identity);
			if (entry.providerId !== providerId || attempted.has(entry.identity) || (blockedUntil !== undefined && blockedUntil > now)) {
				continue;
			}
			this.nextIndex = (index + 1) % this.entries.length;
			return entry;
		}
		return undefined;
	}

	recordFailure({ identity, kind }: { identity: CredentialIdentity; kind: CredentialFailureKind }): void {
		if (kind === "rate_limited" || kind === "blocked") {
			this.blockedUntilByIdentity.set(identity, this.now() + this.cooldownMs);
		}
	}

	snapshot(): CredentialPoolSnapshotEntry[] {
		return this.entries.map((entry) => ({
			identity: entry.identity,
			providerId: entry.providerId,
			blockedUntil: this.blockedUntilByIdentity.get(entry.identity),
		}));
	}

	private activeLease(identity: CredentialIdentity): CredentialRefreshLease | undefined {
		const lease = this.refreshLeaseByIdentity.get(identity);
		if (!lease) return undefined;
		if (lease.expiresAt <= this.now()) {
			this.refreshLeaseByIdentity.delete(identity);
			return undefined;
		}
		return lease;
	}

	/** Grant a refresh lease for an identity, unless another owner already holds an unexpired one. */
	acquireRefreshLease({
		identity,
		owner,
		durationMs,
	}: {
		identity: CredentialIdentity;
		owner: string;
		durationMs: number;
	}): CredentialRefreshLease | undefined {
		const existing = this.activeLease(identity);
		if (existing && existing.owner !== owner) return undefined;
		const lease: CredentialRefreshLease = { identity, owner, expiresAt: this.now() + durationMs };
		this.refreshLeaseByIdentity.set(identity, lease);
		return lease;
	}

	/** Release a held refresh lease. Returns false if the caller is not the current owner. */
	releaseRefreshLease({ identity, owner }: { identity: CredentialIdentity; owner: string }): boolean {
		const existing = this.activeLease(identity);
		if (!existing || existing.owner !== owner) return false;
		this.refreshLeaseByIdentity.delete(identity);
		return true;
	}
}
