import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateUsagePerformance } from "../../src/core/observability/aggregate.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SqliteUsagePerformanceStore } from "../../src/core/usage-performance-store.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function scratchDir(label: string): string {
	const dir = join(tmpdir(), `apex-reconciliation-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function usage(cost: number): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: cost * 0.6, output: cost * 0.4, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantMessage(cost: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(cost),
		stopReason: "stop",
		timestamp,
	};
}

function toolResultMessage(cost: number, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "summarize",
		content: [{ type: "text", text: "tool summary" }],
		usage: usage(cost),
		isError: false,
		timestamp,
	};
}

describe("ledger vs. getUsageCostBreakdown reconciliation (task 8.2)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("sums to exactly the same total across assistant messages, a tool result, and a compaction entry", async () => {
		const agentDir = scratchDir("exact");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		const sessionId = "session-reconcile-1";

		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		sessionManager.appendMessage(assistantMessage(0.1, 2));
		sessionManager.appendMessage(assistantMessage(0.05, 3));
		sessionManager.appendMessage(toolResultMessage(0.02, 4));
		sessionManager.appendCompaction("summary", userId, 150, undefined, false, usage(0.03));

		const store = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"), sessionId);
		cleanups.push(() => store.close());
		// Every entry above that carries a cost corresponds to one real ModelRuntime
		// request attempt in production (assistant turns and compaction both route
		// through the same modelRuntime.streamSimple-backed streamFn -- verified via
		// sdk.ts's Agent construction and context/pipeline.ts's wrapping, which always
		// delegates rather than replacing it). The tool-result case has no first-party
		// producer today but is a legitimate SessionEntry shape the breakdown already
		// handles, so it's included to prove the aggregate isn't hardcoded to only two
		// entry kinds.
		await store.record({
			timestamp: 2,
			provider: model.provider,
			model: model.id,
			outcome: "success",
			ttftMs: 5,
			generationMs: 10,
			cost: 0.1,
		});
		await store.record({
			timestamp: 3,
			provider: model.provider,
			model: model.id,
			outcome: "success",
			ttftMs: 5,
			generationMs: 10,
			cost: 0.05,
		});
		await store.record({
			timestamp: 4,
			provider: model.provider,
			model: model.id,
			outcome: "success",
			ttftMs: 5,
			generationMs: 10,
			cost: 0.02,
		});
		await store.record({
			timestamp: 5,
			provider: model.provider,
			model: model.id,
			outcome: "success",
			ttftMs: 5,
			generationMs: 10,
			cost: 0.03,
		});

		const breakdown = getUsageCostBreakdown(sessionManager.getEntries());
		const breakdownTotal = breakdown.reduce((sum, entry) => sum + entry.cost, 0);

		const samples = await store.list();
		const ledgerRows = aggregateUsagePerformance(samples, "session");
		const ledgerTotal = ledgerRows.find((row) => row.key === sessionId)?.cost ?? 0;

		expect(breakdownTotal).toBeCloseTo(0.2, 10);
		expect(ledgerTotal).toBeCloseTo(0.2, 10);
		expect(ledgerTotal).toBe(breakdownTotal);
	});

	it("keeps sessions independent: a second session's ledger rows never inflate the first session's aggregate", async () => {
		const agentDir = scratchDir("isolation");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const storeA = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"), "session-a");
		const storeB = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"), "session-b");
		cleanups.push(
			() => storeA.close(),
			() => storeB.close(),
		);

		await storeA.record({
			timestamp: 1,
			provider: "acme",
			model: "acme-large",
			outcome: "success",
			ttftMs: 1,
			generationMs: 1,
			cost: 0.5,
		});
		await storeB.record({
			timestamp: 2,
			provider: "acme",
			model: "acme-large",
			outcome: "success",
			ttftMs: 1,
			generationMs: 1,
			cost: 0.75,
		});

		const rows = aggregateUsagePerformance(await storeA.list(), "session");
		expect(rows.find((row) => row.key === "session-a")?.cost).toBe(0.5);
		expect(rows.find((row) => row.key === "session-b")?.cost).toBe(0.75);
	});
});
