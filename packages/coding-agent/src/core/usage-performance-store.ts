/**
 * Durable, non-secret per-request usage and latency samples. One sample per
 * request attempt (win or rotated-away), sufficient for future measured routing
 * (roadmap Phase 1's `model_perf` table) without inferring latency after the fact.
 * Never holds a credential secret — only the opaque CredentialIdentity label.
 */

import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";
import type { CredentialFailureKind, CredentialIdentity } from "./credential-pool.ts";

export interface UsagePerformanceSample {
	timestamp: number;
	provider: string;
	model: string;
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

const STORE_VERSION = 1;

interface StoredUsagePerformance {
	version: number;
	samples: UsagePerformanceSample[];
}

function emptyStore(): StoredUsagePerformance {
	return { version: STORE_VERSION, samples: [] };
}

function parseStore(content: string | undefined): StoredUsagePerformance {
	if (!content) return emptyStore();
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return emptyStore();
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as Partial<StoredUsagePerformance>).version !== STORE_VERSION ||
		!Array.isArray((parsed as Partial<StoredUsagePerformance>).samples)
	) {
		return emptyStore();
	}
	return parsed as StoredUsagePerformance;
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

/** Versioned, mode-0600 file-backed store. Transitional: Phase 6 supersedes this with SQLite. */
export class FileUsagePerformanceStore implements UsagePerformanceStore {
	private readonly storage: AuthStorageBackend;

	constructor(path: string = join(getAgentDir(), "usage-performance.json")) {
		this.storage = new FileAuthStorageBackend(normalizePath(path));
	}

	async record(sample: UsagePerformanceSample): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = parseStore(content);
			current.samples.push(sample);
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}

	async list(): Promise<readonly UsagePerformanceSample[]> {
		return this.storage.withLockAsync(async (content) => ({ result: parseStore(content).samples }));
	}
}
