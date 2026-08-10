import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replay } from "../src/testing/replay/runner.ts";

function corpusFixture(name: string): string {
	return fileURLToPath(new URL(`../../../fixtures/corpus/${name}`, import.meta.url));
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
		expect(result.metrics.contextTokensByTurn[0]).toBeGreaterThan(8_000);
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
		expect(result.metrics.contextTokensByTurn.slice(18)).toEqual([27, 45, 63, 81]);
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

	it("returns deterministic output for the same recording", async () => {
		const first = await replay(corpusFixture("tool-error-recovery.jsonl"));
		const second = await replay(corpusFixture("tool-error-recovery.jsonl"));

		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
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
