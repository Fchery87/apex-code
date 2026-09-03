import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import {
	appendWorkspaceComparison,
	appendWorkspaceObservation,
	CUSTOM_TYPE_COMPARISON,
	CUSTOM_TYPE_OBSERVATION,
	findWorkspaceObservationForCompaction,
	listWorkspaceComparisons,
	readWorkspaceObservation,
	type WorkspaceArtifactRef,
} from "../../src/core/workspace/state.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "apex-workspace-state-"));
});

afterEach(() => {
	rmSync(scratch, { force: true, recursive: true });
});

/**
 * The session file only materializes once the first assistant message flushes
 * the buffered header (see SessionManager._persist). File-backed tests call
 * this after the user message.
 */
function appendAssistantFlush(session: SessionManager): void {
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
}

/** A compaction entry exactly as older versions wrote it: no workspace fields. */
function preFeatureSessionFile(path: string): void {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "ws-fix",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: scratch,
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		}),
		JSON.stringify({
			type: "compaction",
			id: "c1",
			parentId: "m2",
			timestamp: "2026-01-01T00:00:03.000Z",
			summary: "Earlier turns summarized.",
			firstKeptEntryId: "m2",
			tokensBefore: 1000,
			details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
		}),
		"",
	];
	writeFileSync(path, lines.join("\n"), "utf-8");
}

describe("workspace state session records", () => {
	it("loads a pre-feature compaction entry unchanged and preserves its file ledger after a workspace observation is added", () => {
		const sessionPath = join(scratch, "pre.jsonl");
		preFeatureSessionFile(sessionPath);

		const first = SessionManager.open(sessionPath);
		const compaction = first.getEntries().find((e) => e.type === "compaction");
		expect(compaction).toBeDefined();
		expect((compaction as { summary: string }).summary).toBe("Earlier turns summarized.");
		expect((compaction as { details?: unknown }).details).toEqual({
			readFiles: ["src/a.ts"],
			modifiedFiles: ["src/b.ts"],
		});

		appendWorkspaceObservation(first, {
			version: 1,
			observationId: "obs-1",
			status: "unsupported",
			backend: "none",
			workspaceRoot: scratch,
			capturedAt: "2026-01-01T00:00:04.000Z",
			coverage: {
				tracked: false,
				staged: false,
				unstaged: false,
				untracked: false,
				ignored: false,
				hashes: false,
				patch: false,
			},
			paths: [],
			warnings: [],
		});

		const second = SessionManager.open(sessionPath);
		const compaction2 = second.getEntries().find((e) => e.type === "compaction") as {
			details?: unknown;
			summary: string;
		};
		// The pre-feature entry is byte-for-byte the same shape as before.
		expect(compaction2.summary).toBe("Earlier turns summarized.");
		expect(compaction2.details).toEqual({ readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] });

		const found = findWorkspaceObservationForCompaction(second, "c1");
		expect(found).toBeDefined();
		expect(found?.record.observationId).toBe("obs-1");
		expect(found?.record.status).toBe("unsupported");
	});

	it("ignores unknown additive fields on compaction entries", () => {
		const sessionPath = join(scratch, "unknown.jsonl");
		preFeatureSessionFile(sessionPath);
		// Simulate a future writer: an unknown top-level field on the compaction
		// entry. Readers must keep the entry and its known fields intact.
		const text = readFileSync(sessionPath, "utf-8").replace(
			'"tokensBefore":1000',
			'"tokensBefore":1000,"futureField":{"nested":true}',
		);
		writeFileSync(sessionPath, text, "utf-8");

		const session = SessionManager.open(sessionPath);
		const compaction = session.getEntries().find((e) => e.type === "compaction") as
			| (SessionEntry & { tokensBefore?: number; summary?: string })
			| undefined;
		expect(compaction).toBeDefined();
		expect(compaction?.summary).toBe("Earlier turns summarized.");
		expect(compaction?.tokensBefore).toBe(1000);
	});

	it("round-trips an observation as a child of its compaction entry and keeps it out of LLM context", () => {
		const session = SessionManager.create(scratch, scratch);
		session.appendMessage({ role: "user", content: "work", timestamp: 1 });
		appendAssistantFlush(session);
		const c1 = session.appendCompaction("Summary text.", "", 500, { readFiles: [], modifiedFiles: [] });
		appendWorkspaceObservation(session, {
			version: 1,
			observationId: "obs-2",
			status: "observed",
			backend: "git",
			workspaceRoot: scratch,
			capturedAt: "2026-01-01T00:00:04.000Z",
			coverage: {
				tracked: true,
				staged: true,
				unstaged: true,
				untracked: true,
				ignored: true,
				hashes: true,
				patch: false,
			},
			base: { headCommit: "abc123", branch: "main" },
			paths: [{ path: "src/a.ts", kind: "modified", unstaged: true, contentHash: "sha256:dead" }],
			warnings: ["untracked paths truncated at limit"],
		});

		const reopened = SessionManager.open(join(scratch, latestFile(scratch)));
		const found = findWorkspaceObservationForCompaction(reopened, c1);
		expect(found).toBeDefined();
		expect(found?.record).toMatchObject({
			version: 1,
			observationId: "obs-2",
			status: "observed",
			backend: "git",
		});
		expect(found?.record.base).toEqual({ headCommit: "abc123", branch: "main" });
		expect(found?.record.paths).toHaveLength(1);

		// The observation must not enter LLM context.
		const context = reopened.buildSessionContext();
		const serialized = JSON.stringify(context.messages);
		expect(serialized).not.toContain("apex.workspace.observation");
		expect(serialized).not.toContain("obs-2");
	});

	it("keeps comparisons as separate historical records and never rewrites the observation", () => {
		const session = SessionManager.create(scratch, scratch);
		session.appendMessage({ role: "user", content: "work", timestamp: 1 });
		appendAssistantFlush(session);
		const c1 = session.appendCompaction("Summary.", "", 10, { readFiles: [], modifiedFiles: [] });
		appendWorkspaceObservation(session, {
			version: 1,
			observationId: "obs-3",
			status: "observed",
			backend: "git",
			workspaceRoot: scratch,
			capturedAt: "2026-01-01T00:00:04.000Z",
			coverage: {
				tracked: true,
				staged: true,
				unstaged: true,
				untracked: false,
				ignored: false,
				hashes: true,
				patch: false,
			},
			paths: [],
			warnings: [],
		});

		appendWorkspaceComparison(session, {
			version: 1,
			comparedAt: "2026-01-01T00:01:00.000Z",
			result: "same",
			comparedToObservationId: "obs-3",
			warnings: [],
		});
		appendWorkspaceComparison(session, {
			version: 1,
			comparedAt: "2026-01-01T00:02:00.000Z",
			result: "drifted",
			comparedToObservationId: "obs-3",
			changedPaths: ["src/late.ts"],
			warnings: [],
		});

		const reopened = SessionManager.open(join(scratch, latestFile(scratch)));
		const found = findWorkspaceObservationForCompaction(reopened, c1);
		expect(found?.record.observationId).toBe("obs-3");
		expect(found?.record.status).toBe("observed");

		const comparisons = listWorkspaceComparisons(reopened, "obs-3");
		expect(comparisons).toHaveLength(2);
		expect(comparisons[0]?.result).toBe("same");
		expect(comparisons[1]?.result).toBe("drifted");
		expect(comparisons[1]?.changedPaths).toEqual(["src/late.ts"]);
	});

	it("round-trips an artifact reference inside the record", () => {
		const session = SessionManager.create(scratch, scratch);
		session.appendMessage({ role: "user", content: "work", timestamp: 1 });
		appendAssistantFlush(session);
		const c1 = session.appendCompaction("Summary.", "", 10, { readFiles: [], modifiedFiles: [] });
		const artifactRef: WorkspaceArtifactRef = {
			artifactId: "art-1",
			file: "20260101T000000_fix.artifacts/workspace-state/obs-4.patch",
			sha256: "sha256:cafe",
			bytes: 1234,
		};
		appendWorkspaceObservation(session, {
			version: 1,
			observationId: "obs-4",
			status: "observed",
			backend: "git",
			workspaceRoot: scratch,
			capturedAt: "2026-01-01T00:00:04.000Z",
			coverage: {
				tracked: true,
				staged: true,
				unstaged: true,
				untracked: false,
				ignored: false,
				hashes: true,
				patch: true,
			},
			paths: [],
			patchArtifactRef: artifactRef,
			patchBytes: 1234,
			patchComplete: true,
			warnings: [],
		});

		const reopened = SessionManager.open(join(scratch, latestFile(scratch)));
		const found = findWorkspaceObservationForCompaction(reopened, c1);
		expect(found?.record.patchArtifactRef).toEqual(artifactRef);
		expect(found?.record.patchComplete).toBe(true);
	});

	it("returns undefined for entries that are not workspace observations", () => {
		const session = SessionManager.inMemory();
		const id = session.appendCustomEntry("someone_elses_data", { any: true });
		const entry = session.getEntry(id);
		expect(readWorkspaceObservation(entry)).toBeUndefined();
		expect(entry?.type === "custom" && (entry as { customType: string }).customType).toBe("someone_elses_data");
		expect(CUSTOM_TYPE_OBSERVATION).not.toBe(CUSTOM_TYPE_COMPARISON);
	});
});

/** Newest .jsonl file in the directory (sessions write through after flush). */
function latestFile(dir: string): string {
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	expect(files.length).toBeGreaterThan(0);
	return files.sort().at(-1) as string;
}
