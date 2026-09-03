import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { compareWorkspaceObservations, MAX_CHANGED_PATHS } from "../../src/core/workspace/comparison.ts";
import type { WorkspaceStateRecord } from "../../src/core/workspace/state.ts";
import { readWorkspaceComparison, WORKSPACE_RECORD_VERSION } from "../../src/core/workspace/state.ts";
import { createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

/**
 * WS.5: post-compaction and resume workspace drift comparison (spec
 * 2026-09-01-harness-correctness-and-workspace-state.md § 3). One comparison
 * per lifecycle boundary, persisted as an additive comparison entry; the
 * original observation stays historical; unavailable and inconclusive are
 * honest outcomes; comparison problems never fail the user's turn.
 */

function makeRecord(overrides: Partial<WorkspaceStateRecord> = {}): WorkspaceStateRecord {
	return {
		version: WORKSPACE_RECORD_VERSION,
		observationId: "obs-1",
		status: "observed",
		backend: "git",
		workspaceRoot: "/repo",
		capturedAt: "2026-09-01T00:00:00.000Z",
		coverage: {
			tracked: true,
			staged: true,
			unstaged: true,
			untracked: true,
			ignored: true,
			hashes: true,
			patch: false,
		},
		base: { headCommit: "a".repeat(40), branch: "main" },
		paths: [],
		warnings: [],
		...overrides,
	};
}

const SAME_TREE = {
	indexDigest: "sha256:aaa",
	worktreeDigest: "sha256:www",
};

describe("compareWorkspaceObservations", () => {
	it("reports same when both digests match", () => {
		const stored = makeRecord({ base: { ...SAME_TREE } });
		const fresh = makeRecord({ observationId: "obs-2", base: { ...SAME_TREE } });
		const outcome = compareWorkspaceObservations(stored, fresh);
		expect(outcome.result).toBe("same");
		expect(outcome.changedPaths).toBeUndefined();
	});

	it("reports drifted with the symmetric path diff", () => {
		const stored = makeRecord({
			base: { ...SAME_TREE },
			paths: [
				{ path: "src/a.ts", kind: "modified", unstaged: true, contentHash: "sha256:1" },
				{ path: "gone.txt", kind: "untracked" },
			],
		});
		const fresh = makeRecord({
			observationId: "obs-2",
			base: { ...SAME_TREE, worktreeDigest: "sha256:zzz" },
			paths: [
				{ path: "src/a.ts", kind: "modified", unstaged: true, contentHash: "sha256:2" },
				{ path: "new.txt", kind: "untracked" },
			],
		});
		const outcome = compareWorkspaceObservations(stored, fresh);
		expect(outcome.result).toBe("drifted");
		expect(outcome.changedPaths).toEqual(["gone.txt", "new.txt", "src/a.ts"]);
	});

	it("reports unavailable when the fresh observation is missing", () => {
		const stored = makeRecord({ base: { ...SAME_TREE } });
		const outcome = compareWorkspaceObservations(stored, undefined);
		expect(outcome.result).toBe("unavailable");
		expect(outcome.changedPaths).toBeUndefined();
	});

	it("reports unavailable when the adapter could not observe", () => {
		const stored = makeRecord({ base: { ...SAME_TREE } });
		for (const status of ["failed", "unsupported"] as const) {
			const fresh = makeRecord({ observationId: "obs-2", status });
			const outcome = compareWorkspaceObservations(stored, fresh);
			expect(outcome.result).toBe("unavailable");
		}
	});

	it("reports inconclusive when either side is incomplete", () => {
		const stored = makeRecord({ base: { ...SAME_TREE } });
		const freshIncomplete = makeRecord({
			observationId: "obs-2",
			status: "incomplete",
			base: { ...SAME_TREE, worktreeDigest: "sha256:zzz" },
		});
		expect(compareWorkspaceObservations(stored, freshIncomplete).result).toBe("inconclusive");

		const storedIncomplete = makeRecord({ status: "incomplete", base: { ...SAME_TREE } });
		const fresh = makeRecord({ observationId: "obs-2", base: { ...SAME_TREE, worktreeDigest: "sha256:zzz" } });
		const outcome = compareWorkspaceObservations(storedIncomplete, fresh);
		expect(outcome.result).toBe("inconclusive");
		expect(outcome.warnings.join(" ")).toContain("stored");
	});

	it("reports inconclusive when the stored baseline has no digest", () => {
		const stored = makeRecord({ status: "failed" });
		const fresh = makeRecord({ observationId: "obs-2", base: { ...SAME_TREE } });
		expect(compareWorkspaceObservations(stored, fresh).result).toBe("inconclusive");
	});

	it("caps changedPaths and says so", () => {
		const many = Array.from({ length: MAX_CHANGED_PATHS + 10 }, (_, i) => ({
			path: `p${String(i).padStart(4, "0")}.txt`,
			kind: "untracked" as const,
		}));
		const stored = makeRecord({ base: { ...SAME_TREE } });
		const fresh = makeRecord({
			observationId: "obs-2",
			base: { ...SAME_TREE, worktreeDigest: "sha256:zzz" },
			paths: many,
		});
		const outcome = compareWorkspaceObservations(stored, fresh);
		expect(outcome.result).toBe("drifted");
		expect(outcome.changedPaths).toHaveLength(MAX_CHANGED_PATHS);
		expect(outcome.warnings.join(" ")).toContain("changed path");
	});

	it("warns when the stored patch artifact is missing on disk", () => {
		const stored = makeRecord({
			base: { ...SAME_TREE },
			patchArtifactRef: { artifactId: "art-1", file: "ws/missing.jsonl.patch", sha256: "sha256:abc", bytes: 3 },
		});
		const fresh = makeRecord({ observationId: "obs-2", base: { ...SAME_TREE } });
		const outcome = compareWorkspaceObservations(stored, fresh, { artifactProbe: () => false });
		expect(outcome.result).toBe("same");
		expect(outcome.warnings.join(" ")).toContain("artifact");
	});
});

describe("workspace comparison boundaries", () => {
	let tempDir: string;
	let sessionsDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apex-ws-comparison-"));
		sessionsDir = join(tempDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		execFileSync("git", ["init", "-b", "main", tempDir]);
		git(tempDir, "config", "user.email", "ws@example.com");
		git(tempDir, "config", "user.name", "ws");
		writeFileSync(join(tempDir, "tracked.txt"), "one\n");
		git(tempDir, "add", "-A");
		git(tempDir, "commit", "-m", "initial");
		writeFileSync(join(tempDir, "tracked.txt"), "one changed\n");

		sessionManager = SessionManager.create(tempDir, sessionsDir);
		settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	});

	afterEach(() => {
		session?.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", args, { cwd, encoding: "utf-8" });
	}

	function comparisons(): { comparedToObservationId: string; result: string; changedPaths?: string[] }[] {
		return sessionManager
			.getEntries()
			.map(readWorkspaceComparison)
			.filter((c): c is NonNullable<typeof c> => c !== undefined);
	}

	async function createSession(): Promise<AgentSession> {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		// Dummy key for the auth preflight only; the turn stream is mocked.
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "sk-test-unused" }));
		const modelRegistry = await createModelRegistry(authStorage);
		session = new AgentSession({
			agent: new Agent({
				streamFn: streamSimple,
				initialState: {
					model: getModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: "Test",
					tools: [],
				},
			}),
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		mockTurn(session);
		seedHistory();
		return session;
	}

	function mockTurn(target: AgentSession): void {
		const turnModel = target.model!;
		target.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("Done."),
						api: turnModel.api,
						provider: turnModel.provider,
						model: turnModel.id,
						usage: {
							input: 10,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 10,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					} satisfies AssistantMessage,
				});
			});
			return stream;
		};
	}

	function seedHistory(): void {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: Date.now() - 1000,
		});
		const model = session.model!;
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response to compact" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 5000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 500,
		});
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
	}

	async function compactOnce(): Promise<void> {
		const result = await session.compact();
		expect(result.summary.length).toBeGreaterThan(0);
	}

	it("reports concurrent edits after compaction as drift at the first post-compaction turn", async () => {
		await createSession();
		await compactOnce();
		writeFileSync(join(tempDir, "tracked.txt"), "one changed twice\n");
		await session.prompt("next turn");
		const entries = comparisons();
		expect(entries).toHaveLength(1);
		expect(entries[0].result).toBe("drifted");
		expect(entries[0].changedPaths).toEqual(["tracked.txt"]);
		// The observation stays historical: the comparison names it.
		expect(entries[0].comparedToObservationId).toBeTruthy();
		// Exactly one per boundary: the second turn must not re-compare.
		await session.prompt("turn after that");
		expect(comparisons()).toHaveLength(1);
	});

	it("reports same when nothing moved after compaction", async () => {
		await createSession();
		await compactOnce();
		await session.prompt("next turn");
		const entries = comparisons();
		expect(entries).toHaveLength(1);
		expect(entries[0].result).toBe("same");
	});

	it("reports unavailable when the workspace cannot be observed", async () => {
		await createSession();
		await compactOnce();
		// Baseline stored; now the adapter dies on every fresh capture.
		(session as unknown as Record<string, unknown>)._workspaceObserver = async () => {
			throw new Error("git exploded");
		};
		await session.prompt("next turn");
		const entries = comparisons();
		expect(entries).toHaveLength(1);
		expect(entries[0].result).toBe("unavailable");
		expect(entries[0].changedPaths).toBeUndefined();
	});

	it("reports inconclusive when the fresh capture is incomplete", async () => {
		await createSession();
		(session as unknown as Record<string, unknown>)._workspaceObserver = async () =>
			makeRecord({
				observationId: "fresh-incomplete",
				status: "incomplete",
				workspaceRoot: tempDir,
			});
		await compactOnce();
		await session.prompt("next turn");
		expect(comparisons()[0]?.result).toBe("inconclusive");
	});

	it("compares once on resume when the session has an uncompared observation", async () => {
		await createSession();
		await compactOnce();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("no session file");
		session.dispose();
		writeFileSync(join(tempDir, "tracked.txt"), "edited while away\n");

		sessionManager = SessionManager.open(sessionFile, sessionsDir);
		await createSession();
		await session.prompt("first turn after resume");
		const entries = comparisons();
		expect(entries).toHaveLength(1);
		expect(entries[0].result).toBe("drifted");
		expect(entries[0].changedPaths).toEqual(["tracked.txt"]);
		await session.prompt("second turn after resume");
		expect(comparisons()).toHaveLength(1);
	});

	it("never fails the turn when comparison blows up", async () => {
		await createSession();
		await compactOnce();
		(session as unknown as Record<string, unknown>)._workspaceObserver = async () => {
			throw new Error("boom");
		};
		// Force the persistence layer to throw too.
		const original = sessionManager.appendCustomEntry.bind(sessionManager);
		(sessionManager as unknown as Record<string, unknown>).appendCustomEntry = () => {
			throw new Error("disk full");
		};
		await expect(session.prompt("next turn")).resolves.toBeUndefined();
		(sessionManager as unknown as Record<string, unknown>).appendCustomEntry = original;
		expect(comparisons()).toHaveLength(0);
		// The turn itself completed: a user message and an assistant reply exist.
		const roles = sessionManager
			.getEntries()
			.filter((e) => e.type === "message")
			.map((e) => (e as { message: { role: string } }).message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	});
});
