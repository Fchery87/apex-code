import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { formatWorkspaceProjection } from "../../src/core/workspace/projection.ts";
import type { WorkspaceStateRecord } from "../../src/core/workspace/state.ts";
import { findWorkspaceObservationForCompaction, readWorkspaceObservation } from "../../src/core/workspace/state.ts";
import { createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

/**
 * WS.4: workspace observation is part of the compaction transaction (spec
 * 2026-09-01-harness-correctness-and-workspace-state.md § 3). One capture
 * attempt per compaction, shared by the manual and automatic paths; the
 * observation lands as a child entry of the compaction entry; the model
 * sees only the bounded projection; capture problems never fail the
 * compaction itself.
 */

describe("workspace compaction integration", () => {
	let tempDir: string;
	let sessionsDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apex-ws-compaction-"));
		sessionsDir = join(tempDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		// A real git repository with uncommitted work, so the observer has
		// something honest to report.
		execFileSync("git", ["init", "-b", "main", tempDir]);
		git(tempDir, "config", "user.email", "ws@example.com");
		git(tempDir, "config", "user.name", "ws");
		writeFileSync(join(tempDir, "tracked.txt"), "one\n");
		git(tempDir, "add", "-A");
		git(tempDir, "commit", "-m", "initial");
		writeFileSync(join(tempDir, "tracked.txt"), "one changed\n");
		writeFileSync(join(tempDir, "notes.txt"), "untracked\n");

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

	async function createSession(): Promise<AgentSession> {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
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
		mockSummarizer(session);
		seedHistory();
		return session;
	}

	function mockSummarizer(target: AgentSession): void {
		const summaryModel = target.model!;
		target.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("Compacted summary of the conversation."),
						api: summaryModel.api,
						provider: summaryModel.provider,
						model: summaryModel.id,
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
		const model = session.model!;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: Date.now() - 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "assistant response to compact" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 500,
		});
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
	}

	function compactionEntryIds(): string[] {
		return sessionManager
			.getEntries()
			.filter((e) => e.type === "compaction")
			.map((e) => e.id);
	}

	it("manual compaction records the workspace observation as a child of the compaction entry", async () => {
		await createSession();
		await session.compact();

		const compactionIds = compactionEntryIds();
		expect(compactionIds).toHaveLength(1);
		const observation = findWorkspaceObservationForCompaction(sessionManager, compactionIds[0])?.record;
		expect(observation).toBeDefined();
		expect(observation!.backend).toBe("git");
		expect(observation!.status).toBe("observed");
		expect(observation!.paths.some((p) => p.path === "tracked.txt" && p.unstaged)).toBe(true);
		expect(observation!.paths.some((p) => p.path === "notes.txt")).toBe(true);
		expect(observation!.base?.branch).toBe("main");
	});

	it("the model-facing summary carries only the bounded projection", async () => {
		await createSession();
		const result = await session.compact();

		expect(result.summary).toContain("Workspace:");
		expect(result.summary).toContain("tracked.txt");
		expect(result.summary).toContain("observed");
		// Bounded means no hashes and no full sha256 material in context.
		expect(result.summary).not.toMatch(/sha256:[0-9a-f]{16}/);
		expect(result.summary).not.toContain(tempDir);
		// The persisted summary (with the projection) matches what the model saw.
		const entry = sessionManager.getEntries().find((e) => e.type === "compaction") as { summary: string } | undefined;
		expect(entry?.summary).toBe(result.summary);
	});

	it("records an honest unsupported observation for a non-Git workspace without failing compaction", async () => {
		rmSync(join(tempDir, ".git"), { recursive: true, force: true });
		await createSession();
		const result = await session.compact();

		expect(result.summary).toContain("Workspace:");
		expect(result.summary).toContain("unsupported");
		const compactionIds = compactionEntryIds();
		const observation = findWorkspaceObservationForCompaction(sessionManager, compactionIds[0])?.record;
		expect(observation?.status).toBe("unsupported");
	});

	it("a capture failure downgrades to a failed observation and compaction still succeeds", async () => {
		await createSession();
		const failed: WorkspaceStateRecord = {
			version: 1,
			observationId: "test-obs-failed",
			status: "failed",
			backend: "git",
			workspaceRoot: tempDir,
			capturedAt: new Date().toISOString(),
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
			warnings: ["injected failure"],
		};
		(session as unknown as { _workspaceObserver: unknown })._workspaceObserver = async () => failed;

		const result = await session.compact();

		expect(result.summary).toContain("failed");
		const observation = findWorkspaceObservationForCompaction(sessionManager, compactionEntryIds()[0]);
		expect(observation?.record.status).toBe("failed");
		expect(observation?.record.warnings).toContain("injected failure");
	});

	it("automatic threshold compaction records the observation through the same path", async () => {
		await createSession();
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		// No queued messages: the queue-drain contract resolves false even on
		// success; the compaction entry and its observation are the evidence.
		await expect(runAutoCompaction("threshold", false)).resolves.toBe(false);

		const compactionIds = compactionEntryIds();
		expect(compactionIds).toHaveLength(1);
		const observation = findWorkspaceObservationForCompaction(sessionManager, compactionIds[0])?.record;
		expect(observation).toBeDefined();
		expect(observation!.backend).toBe("git");
		// No duplicated capture: exactly one observation per compaction.
		const all = sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && readWorkspaceObservation(e) !== undefined);
		expect(all).toHaveLength(1);
	});

	it("keeps extension-provided compaction summaries untouched while still observing", async () => {
		await createSession();
		const extensionSummary = "Extension-owned summary. Do not touch.";
		(session as unknown as { _extensionRunner: Record<string, unknown> })._extensionRunner = {
			hasHandlers: (t: string) => t === "session_before_compact",
			invalidate: () => {},
			getAllRegisteredTools: () => [],
			emit: async (event: unknown) => {
				const e = event as { type: string };
				if (e.type === "session_before_compact") {
					return {
						cancel: false,
						compaction: {
							summary: extensionSummary,
							firstKeptEntryId: "",
							tokensBefore: 100,
							details: { extensionOwned: true },
						},
					};
				}
				return undefined;
			},
		};

		const result = await session.compact();

		expect(result.summary).toBe(extensionSummary);
		const observation = findWorkspaceObservationForCompaction(sessionManager, compactionEntryIds()[0]);
		expect(observation).toBeDefined();
	});

	it("captures nothing to the artifact store when patch capture is off", async () => {
		await createSession();
		await session.compact();
		const files = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
		expect(files.some((f) => f.endsWith(".artifacts"))).toBe(false);
	});
});

describe("workspace projection formatting", () => {
	const base: WorkspaceStateRecord = {
		version: 1,
		observationId: "obs-1",
		status: "observed",
		backend: "git",
		workspaceRoot: "/repo",
		capturedAt: "2026-09-03T00:00:00.000Z",
		coverage: {
			tracked: true,
			staged: true,
			unstaged: true,
			untracked: true,
			ignored: true,
			hashes: true,
			patch: false,
		},
		base: { headCommit: "abcdef1234567890", branch: "main" },
		paths: [
			{ path: "src/a.ts", kind: "modified", staged: true, unstaged: false },
			{ path: "src/b.ts", kind: "modified", staged: false, unstaged: true },
			{ path: "new.txt", kind: "untracked", staged: false, unstaged: false },
			{ path: "old.txt", kind: "deleted", staged: false, unstaged: true },
		],
		warnings: [],
	};

	it("renders status, base identity, and grouped paths without hashes", () => {
		const text = formatWorkspaceProjection(base);
		expect(text).toContain("observed");
		expect(text).toContain("main");
		expect(text).toContain("abcdef1");
		expect(text).toContain("src/a.ts");
		expect(text).toContain("src/b.ts");
		expect(text).toContain("new.txt");
		expect(text).toContain("old.txt");
		expect(text).not.toMatch(/sha256:[0-9a-f]{16}/);
		expect(text).not.toContain("/repo");
	});

	it("groups paths by kind and bounds the listing", () => {
		const many: WorkspaceStateRecord = {
			...base,
			paths: Array.from({ length: 30 }, (_, i) => ({
				path: `file-${String(i).padStart(2, "0")}.ts`,
				kind: "modified" as const,
				staged: false,
				unstaged: true,
			})),
		};
		const text = formatWorkspaceProjection(many);
		expect(text).toContain("file-00.ts");
		expect(text).not.toContain("file-29.ts");
		expect(text).toMatch(/more/i);
	});

	it("states coverage gaps and warnings as notices", () => {
		const text = formatWorkspaceProjection({
			...base,
			status: "incomplete",
			base: { ...base.base!, headCommit: undefined, branch: undefined },
			warnings: ["detached HEAD", "path list truncated at 2 paths"],
		});
		expect(text).toContain("incomplete");
		expect(text).toContain("detached HEAD");
		expect(text).toContain("truncated");
		expect(text).not.toContain("HEAD ");
	});

	it("renders the unsupported and failed states honestly", () => {
		expect(formatWorkspaceProjection({ ...base, status: "unsupported", paths: [] })).toContain("unsupported");
		expect(formatWorkspaceProjection({ ...base, status: "failed", paths: [] })).toContain("failed");
	});
});
