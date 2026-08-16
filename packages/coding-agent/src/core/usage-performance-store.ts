/**
 * Durable, non-secret per-request usage and latency samples. One sample per
 * request attempt (win or rotated-away), sufficient for future measured routing
 * (roadmap Phase 1's `model_perf` table) without inferring latency after the fact.
 * Never holds a credential secret — only the opaque CredentialIdentity label.
 */

import { type CredentialFailureKind, type CredentialIdentity, createCredentialIdentity } from "./credential-pool.ts";
import { type DurableStateStore, openDurableStateStore } from "./durable-state/sqlite.ts";

export interface UsagePerformanceSample {
	timestamp: number;
	provider: string;
	model: string;
	/** Stamped by the store at record time from its own construction, never by the caller. */
	sessionId?: string;
	role?: string;
	/** Opaque, non-secret credential label; absent when no credential pool was involved. */
	credentialIdentity?: CredentialIdentity;
	outcome: "success" | "error" | "aborted";
	/** Only set when outcome is "error"; mirrors credential-failover's rotation classification. */
	failureKind?: CredentialFailureKind;
	ttftMs: number;
	generationMs: number;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost?: number;
}

export interface UsagePerformanceStore {
	record(sample: UsagePerformanceSample): Promise<void>;
	list(): Promise<readonly UsagePerformanceSample[]>;
}

export class InMemoryUsagePerformanceStore implements UsagePerformanceStore {
	private readonly samples: UsagePerformanceSample[] = [];

	async record(sample: UsagePerformanceSample): Promise<void> {
		this.samples.push(structuredClone(sample));
	}

	async list(): Promise<readonly UsagePerformanceSample[]> {
		return this.samples.map((sample) => structuredClone(sample));
	}
}

const DEFAULT_RETENTION_DAYS = 90;

/**
 * Durable, cross-session store backed by the shared durable-state SQLite database
 * (roadmap Phase 8). Constructed per session so every recorded sample is stamped
 * with the session that produced it; `sessionId` is never taken from the sample
 * itself, only from how the store was constructed (see the spec's "Session
 * attribution" note — `ModelRuntime` is session-agnostic and cannot supply this).
 */
export class SqliteUsagePerformanceStore implements UsagePerformanceStore {
	private readonly store: DurableStateStore;
	private readonly sessionId: string | undefined;

	constructor(databasePath: string, sessionId?: string, retentionDays: number = DEFAULT_RETENTION_DAYS) {
		this.store = openDurableStateStore(databasePath);
		this.sessionId = sessionId;
		const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
		this.store.pruneUsagePerformance(cutoff);
	}

	async record(sample: UsagePerformanceSample): Promise<void> {
		this.store.recordUsagePerformance({
			provider: sample.provider,
			modelId: sample.model,
			ttftMs: sample.ttftMs,
			generationMs: sample.generationMs,
			sampledAt: new Date(sample.timestamp).toISOString(),
			sessionId: this.sessionId ?? null,
			role: sample.role ?? null,
			credentialIdentity: sample.credentialIdentity ?? null,
			outcome: sample.outcome,
			failureKind: sample.failureKind ?? null,
			inputTokens: sample.usage?.input ?? null,
			outputTokens: sample.usage?.output ?? null,
			cacheReadTokens: sample.usage?.cacheRead ?? null,
			cacheWriteTokens: sample.usage?.cacheWrite ?? null,
			cost: sample.cost ?? null,
		});
	}

	async list(): Promise<readonly UsagePerformanceSample[]> {
		return this.store.listUsagePerformance().map((row) => ({
			timestamp: Date.parse(row.sampledAt),
			provider: row.provider,
			model: row.modelId,
			sessionId: row.sessionId ?? undefined,
			role: row.role ?? undefined,
			credentialIdentity: row.credentialIdentity ? createCredentialIdentity(row.credentialIdentity) : undefined,
			outcome: row.outcome as UsagePerformanceSample["outcome"],
			failureKind: (row.failureKind ?? undefined) as CredentialFailureKind | undefined,
			ttftMs: row.ttftMs ?? 0,
			generationMs: row.generationMs ?? 0,
			usage:
				row.inputTokens === null
					? undefined
					: {
							input: row.inputTokens,
							output: row.outputTokens ?? 0,
							cacheRead: row.cacheReadTokens ?? 0,
							cacheWrite: row.cacheWriteTokens ?? 0,
						},
			cost: row.cost ?? undefined,
		}));
	}

	close(): void {
		this.store.close();
	}
}
