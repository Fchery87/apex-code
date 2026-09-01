import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EVICTION_MARKER } from "../src/core/context/eviction.ts";
import { replay, replayCorpus } from "../src/testing/replay/runner.ts";

const corpusDirectory = fileURLToPath(new URL("../../../fixtures/corpus/", import.meta.url));

function corpusFixture(name: string): string {
	return join(corpusDirectory, name);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("offline session replay", () => {
	it("replays a session offline and emits metrics", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("replay attempted network access"));

		const result = await replay(corpusFixture("short-single-turn.jsonl"));

		expect(result.turns).toBeGreaterThan(0);
		expect(result.metrics.contextTokensByTurn).toHaveLength(result.turns);
		expect(result.networkCalls).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result.responses).toMatchObject([
			{ role: "assistant", content: [{ type: "text", text: "Fixture response complete." }] },
		]);
	});

	it("replays every recorded provider request while counting user turns", async () => {
		const result = await replay(corpusFixture("heavy-tool-output.jsonl"));

		expect(result.turns).toBe(1);
		expect(result.requests).toBe(2);
		expect(result.responses.map((message) => message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(result.metrics.contextTokensByTurn).toHaveLength(1);
		// This fixture exists to demonstrate eviction on a single huge recoverable
		// result ("Large deterministic result for eviction measurements",
		// fixtures/corpus/README.md). Now that the context pipeline is wired into
		// replay(), that result is evicted before it reaches the outbound request:
		// the pre-wiring value here was >8,000 (the full unevicted result); the real,
		// measured post-eviction value is 1113, the static prefix plus a handful of
		// small messages plus the eviction marker, well under REPLAY_EVICTION_BUDGET.
		// Was 748 while a custom system prompt discarded the tool snippets and
		// guidelines this runner passes; restoring them adds a flat 237 tokens to
		// every measurement in this file. Was 985 before the background-shell schema
		// union (2026-08-31), which adds a flat 128 tokens to every measurement here.
		expect(result.metrics.contextTokensByTurn[0]).toBe(1113);
		const [turnContext] = result.contextsByTurn;
		expect(
			turnContext?.some(
				(message) =>
					message.role === "toolResult" && JSON.stringify(message.content).includes(DEFAULT_EVICTION_MARKER),
			),
		).toBe(true);
	});

	it("preserves a terminal assistant error followed by a later successful turn", async () => {
		const result = await replay(corpusFixture("error-recovery.jsonl"));

		expect(result.turns).toBe(2);
		expect(result.responses.map((message) => message.stopReason)).toEqual(["error", "stop"]);
		expect(result.responses[0]?.errorMessage).toBe("Synthetic upstream timeout.");
	});

	it("honors recorded model changes", async () => {
		const result = await replay(corpusFixture("model-switch.jsonl"));

		expect(result.turns).toBe(2);
		expect(result.responses.map((message) => message.model)).toEqual(["fixture-model-a", "fixture-model-b"]);
	});

	it("uses compaction-aware contexts for long sessions", async () => {
		const result = await replay(corpusFixture("compacted-session.jsonl"));

		expect(result.turns).toBe(22);
		expect(result.requests).toBe(22);
		expect(result.metrics.contextTokensByTurn).toHaveLength(22);
		expect(result.metrics.contextTokensByTurn[18]).toBeLessThan(result.metrics.contextTokensByTurn[17]);
		expect(result.metrics.contextTokensByTurn.slice(18)).toEqual([1099, 1117, 1135, 1153]);
	});

	it("evicts stale recoverable tool results from the outbound context by turn 20 (long-tool-heavy)", async () => {
		const result = await replay(corpusFixture("long-tool-heavy.jsonl"));

		expect(result.turns).toBe(22);
		expect(result.metrics.contextTokensByTurn).toHaveLength(22);

		// Before the context pipeline was wired into replay(), turn 20 here was
		// 15,272 — completely unchanged from the pre-eviction baseline, because
		// replay() built a bare Agent and never installed transformContext/
		// streamFunction eviction at all. The real, measured post-wiring value is
		// 1,769 (an 88.4% drop from that baseline; see REPLAY_EVICTION_BUDGET's
		// comment in runner.ts for how that budget was verified against the
		// theoretical eviction floor). 4,000 is a generous threshold — well below
		// the old unwired value, comfortably above measurement noise — chosen so
		// this test fails loudly if wiring regresses, without being so tight it
		// breaks on a harmless budget retune.
		const turn20Tokens = result.metrics.contextTokensByTurn[19];
		expect(turn20Tokens).toBeLessThan(4_000);

		const turn20Context = result.contextsByTurn[19];
		expect(turn20Context).toBeDefined();
		const hasEvictionMarker = turn20Context?.some(
			(message) =>
				message.role === "toolResult" && JSON.stringify(message.content).includes(DEFAULT_EVICTION_MARKER),
		);
		expect(hasEvictionMarker).toBe(true);
	});

	it("replays tool results through inert tools without touching the filesystem", async () => {
		const result = await replay(corpusFixture("tool-error-recovery.jsonl"));

		expect(result.turns).toBe(1);
		expect(result.requests).toBe(3);
		expect(result.toolResults.map((message) => message.isError)).toEqual([true, false]);
		expect(result.responses.at(-1)?.content).toEqual([
			{ type: "text", text: "Recovered using the fallback fixture." },
		]);
	});

	it("replays only the selected branch", async () => {
		const result = await replay(corpusFixture("branched-session.jsonl"));

		expect(result.turns).toBe(2);
		expect(result.responses.map((message) => message.content)).toEqual([
			[{ type: "text", text: "Initial branch response." }],
			[{ type: "text", text: "Branch A response." }],
		]);
	});

	it("aggregates recorded cache usage and cost", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "apex-replay-"));
		try {
			const source = await readFile(corpusFixture("short-single-turn.jsonl"), "utf8");
			const session = join(scratch, "usage.jsonl");
			await writeFile(
				session,
				source
					.replace(
						'"cacheRead":0,"cacheWrite":0,"totalTokens":30',
						'"cacheRead":30,"cacheWrite":10,"totalTokens":70',
					)
					.replace('"cacheRead":0,"cacheWrite":0,"total":0', '"cacheRead":0.03,"cacheWrite":0.01,"total":0.04'),
			);

			const result = await replay(session);

			expect(result.metrics.cacheHitRate).toBe(0.5);
			expect(result.metrics.costUsd).toBe(0.04);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("reconciles a nonzero recorded cost within 5%, verified against an independent extraction of the same fixture", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "apex-replay-"));
		try {
			const source = await readFile(corpusFixture("short-single-turn.jsonl"), "utf8");
			const session = join(scratch, "nonzero-cost.jsonl");
			await writeFile(
				session,
				source.replace(
					'"cacheRead":0,"cacheWrite":0,"total":0',
					'"cacheRead":0.012,"cacheWrite":0.004,"total":0.153',
				),
			);

			const result = await replay(session);
			const expectedCost = recordedCostFromFixture(session);

			expect(expectedCost).toBeCloseTo(0.153, 5);
			expect(result.metrics.costUsd).toBe(expectedCost);
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("produces byte-identical metrics for two consecutive corpus runs", async () => {
		const first = await replayCorpus(corpusDirectory);
		const second = await replayCorpus(corpusDirectory);

		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	/**
	 * Sums recorded assistant `usage.cost.total` directly from a fixture's raw
	 * JSONL, independent of the replay pipeline entirely — the "provider-reported
	 * cost" ground truth this gate reconciles against. Reading the file a second,
	 * unrelated way is what makes this a real regression guard: it can't drift in
	 * lockstep with a bug in `buildReplayMetrics`.
	 */
	function recordedCostFromFixture(path: string): number {
		let total = 0;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message?.role === "assistant") {
				total += entry.message.usage?.cost?.total ?? 0;
			}
		}
		return total;
	}

	it("reconciles replay-reported cost with recorded fixture cost within 5%, per corpus result, with zero network calls", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("replay attempted network access"));

		const metricsByFixture = await replayCorpus(corpusDirectory);
		const fixtureNames = readdirSync(corpusDirectory)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		expect(Object.keys(metricsByFixture).sort()).toEqual(fixtureNames);

		for (const name of fixtureNames) {
			const expectedCost = recordedCostFromFixture(join(corpusDirectory, name));
			const actualCost = metricsByFixture[name].costUsd;
			if (expectedCost === 0) {
				expect(actualCost, `${name}: expected zero recorded cost`).toBe(0);
				continue;
			}
			const relativeDifference = Math.abs(actualCost - expectedCost) / expectedCost;
			expect(
				relativeDifference,
				`${name}: recorded ${expectedCost}, replay-reported ${actualCost}`,
			).toBeLessThanOrEqual(0.05);
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns deterministic output for the same recording", async () => {
		const first = await replay(corpusFixture("tool-error-recovery.jsonl"));
		const second = await replay(corpusFixture("tool-error-recovery.jsonl"));

		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(first.metrics).toEqual({
			contextTokensByTurn: [1124],
			systemPromptTokens: 1072,
			cacheHitRate: 0,
			toolCallsByName: { read: 2 },
			wallTimeMs: 0,
			costUsd: 0,
			turnsCompleted: 1,
		});
	});

	it("rejects a recorded model mismatch", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "apex-replay-"));
		try {
			const source = await readFile(corpusFixture("model-switch.jsonl"), "utf8");
			const mismatched = source.replace('"modelId":"fixture-model-b"', '"modelId":"fixture-model-a"');
			const session = join(scratch, "mismatched.jsonl");
			await writeFile(session, mismatched);

			await expect(replay(session)).rejects.toThrow("assistant response 2 does not match");
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("rejects malformed parent references before opening the session", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "apex-replay-"));
		try {
			const source = await readFile(corpusFixture("short-single-turn.jsonl"), "utf8");
			const malformed = source.replace('"parentId":"s-u1"', '"parentId":"missing-parent"');
			const session = join(scratch, "malformed.jsonl");
			await writeFile(session, malformed);

			await expect(replay(session)).rejects.toThrow("missing parent");
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("rejects malformed physical JSONL lines", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "apex-replay-"));
		try {
			const source = await readFile(corpusFixture("short-single-turn.jsonl"), "utf8");
			const session = join(scratch, "malformed-lines.jsonl");
			await writeFile(session, `${source}not-json\n`);

			await expect(replay(session)).rejects.toThrow("valid JSONL");
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it("rejects files that are not native v3 sessions", async () => {
		await expect(replay(corpusFixture("missing.jsonl"))).rejects.toThrow("valid JSONL");
	});
});
