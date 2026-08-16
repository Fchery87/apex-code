import type { UsagePerformanceSample } from "../usage-performance-store.ts";

export type UsageAggregateDimension = "model" | "session" | "role";

export interface UsageAggregateRow {
	key: string;
	cost: number;
	sampleCount: number;
	ttftMsTotal: number;
	generationMsTotal: number;
}

export interface UsageAggregateRange {
	sinceMs?: number;
	untilMs?: number;
}

const UNKNOWN_SESSION_KEY = "(unknown session)";
const NO_ROLE_KEY = "(no role)";

function keyFor(sample: UsagePerformanceSample, dimension: UsageAggregateDimension): string {
	if (dimension === "model") return `${sample.provider}/${sample.model}`;
	if (dimension === "session") return sample.sessionId ?? UNKNOWN_SESSION_KEY;
	return sample.role ?? NO_ROLE_KEY;
}

/**
 * Groups durable usage/cost samples by model, session, or role over an optional
 * time range. The one query surface both `apex-code cost` (roadmap Phase 8) and
 * the ledger-vs-`getUsageCostBreakdown` reconciliation gate read, so the two never
 * compute cost through independently-drifting logic.
 */
export function aggregateUsagePerformance(
	samples: readonly UsagePerformanceSample[],
	dimension: UsageAggregateDimension,
	range: UsageAggregateRange = {},
): UsageAggregateRow[] {
	const rows = new Map<string, UsageAggregateRow>();
	for (const sample of samples) {
		if (range.sinceMs !== undefined && sample.timestamp < range.sinceMs) continue;
		if (range.untilMs !== undefined && sample.timestamp > range.untilMs) continue;

		const key = keyFor(sample, dimension);
		let row = rows.get(key);
		if (!row) {
			row = { key, cost: 0, sampleCount: 0, ttftMsTotal: 0, generationMsTotal: 0 };
			rows.set(key, row);
		}
		row.cost += sample.cost ?? 0;
		row.sampleCount += 1;
		row.ttftMsTotal += sample.ttftMs;
		row.generationMsTotal += sample.generationMs;
	}
	return Array.from(rows.values()).sort((a, b) => a.key.localeCompare(b.key));
}
