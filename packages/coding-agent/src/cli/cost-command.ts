import { join } from "node:path";
import {
	aggregateUsagePerformance,
	type UsageAggregateDimension,
	type UsageAggregateRow,
} from "../core/observability/aggregate.ts";
import { SqliteUsagePerformanceStore } from "../core/usage-performance-store.ts";

/** Filename of the shared durable-state database within an agent directory (roadmap Phase 8). */
const DURABLE_STATE_DATABASE_FILENAME = "state.sqlite";

const DIMENSIONS: readonly UsageAggregateDimension[] = ["model", "session", "role"];

export interface ParsedCostArgs {
	dimension: UsageAggregateDimension;
	sinceMs?: number;
}

export interface ParsedCostArgsError {
	error: string;
}

const RELATIVE_DURATION = /^(\d+)([dh])$/;

function parseSince(value: string): number | undefined {
	const relative = RELATIVE_DURATION.exec(value);
	if (relative) {
		const amount = Number(relative[1]);
		const unitMs = relative[2] === "d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
		return Date.now() - amount * unitMs;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/** Parses `apex-code cost` arguments. Pure and side-effect-free for easy testing. */
export function parseCostArgs(args: string[]): ParsedCostArgs | ParsedCostArgsError {
	let dimension: UsageAggregateDimension = "model";
	let sinceMs: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--by") {
			const value = args[++i];
			if (!DIMENSIONS.includes(value as UsageAggregateDimension)) {
				return { error: `--by must be one of ${DIMENSIONS.join(", ")}, got "${value}"` };
			}
			dimension = value as UsageAggregateDimension;
		} else if (arg === "--since") {
			const value = args[++i];
			const parsed = value === undefined ? undefined : parseSince(value);
			if (parsed === undefined) {
				return { error: `--since must be a relative duration like "7d"/"24h" or an ISO date, got "${value}"` };
			}
			sinceMs = parsed;
		} else {
			return {
				error: `Unknown option "${arg}" for "cost". Usage: apex-code cost [--by model|session|role] [--since <duration|date>]`,
			};
		}
	}

	return sinceMs === undefined ? { dimension } : { dimension, sinceMs };
}

function formatMs(value: number): string {
	return `${Math.round(value)}ms`;
}

/** Renders aggregate rows as a fixed-width table. Pure and side-effect-free for easy testing. */
export function formatCostTable(rows: readonly UsageAggregateRow[], dimension: UsageAggregateDimension): string {
	if (rows.length === 0) {
		return "No usage recorded.";
	}

	const columns = rows.map((row) => ({
		key: row.key,
		cost: row.cost.toFixed(3),
		samples: String(row.sampleCount),
		avgTtft: formatMs(row.ttftMsTotal / row.sampleCount),
		avgGeneration: formatMs(row.generationMsTotal / row.sampleCount),
	}));

	const headers = {
		key: dimension,
		cost: "cost ($)",
		samples: "samples",
		avgTtft: "avg ttft",
		avgGeneration: "avg gen",
	};
	const widths = {
		key: Math.max(headers.key.length, ...columns.map((c) => c.key.length)),
		cost: Math.max(headers.cost.length, ...columns.map((c) => c.cost.length)),
		samples: Math.max(headers.samples.length, ...columns.map((c) => c.samples.length)),
		avgTtft: Math.max(headers.avgTtft.length, ...columns.map((c) => c.avgTtft.length)),
		avgGeneration: Math.max(headers.avgGeneration.length, ...columns.map((c) => c.avgGeneration.length)),
	};

	const pad = (value: string, width: number) => value.padEnd(width);
	const lines = [
		`${pad(headers.key, widths.key)}  ${pad(headers.cost, widths.cost)}  ${pad(headers.samples, widths.samples)}  ${pad(headers.avgTtft, widths.avgTtft)}  ${pad(headers.avgGeneration, widths.avgGeneration)}`,
	];
	for (const column of columns) {
		lines.push(
			`${pad(column.key, widths.key)}  ${pad(column.cost, widths.cost)}  ${pad(column.samples, widths.samples)}  ${pad(column.avgTtft, widths.avgTtft)}  ${pad(column.avgGeneration, widths.avgGeneration)}`,
		);
	}
	return lines.join("\n");
}

/**
 * Runs `apex-code cost`. Read-only against the shared durable-state database;
 * never writes, never mutates. The one CLI surface the roadmap's post-landing
 * billing-reconciliation obligation depends on.
 */
export async function runCostCommand(agentDir: string, args: string[]): Promise<void> {
	const parsed = parseCostArgs(args);
	if ("error" in parsed) {
		console.error(parsed.error);
		process.exitCode = 1;
		return;
	}

	const store = new SqliteUsagePerformanceStore(join(agentDir, DURABLE_STATE_DATABASE_FILENAME));
	try {
		const samples = await store.list();
		const rows = aggregateUsagePerformance(samples, parsed.dimension, { sinceMs: parsed.sinceMs });
		console.log(formatCostTable(rows, parsed.dimension));
	} finally {
		store.close();
	}
}
