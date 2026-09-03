import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createGitCheckpoints } from "../src/core/checkpoints/git-checkpoints.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * WS.6: explicit /tree and /fork workspace policies (spec
 * 2026-09-01-harness-correctness-and-workspace-state.md § 4). Navigation is
 * conversational by default and never changes files; a restore happens only
 * under an explicit policy, refuses or cancels on drift, requires a
 * reversible pre-restore checkpoint before overwriting anything, and reports
 * missing checkpoints and failures honestly.
 */

describe("session tree navigation workspace policies", () => {
	let tempDir: string;
	let sessionsDir: string;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let engine: NonNullable<Awaited<ReturnType<typeof createGitCheckpoints>>>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apex-ws-tree-"));
		sessionsDir = join(tempDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		execFileSync("git", ["init", "-b", "main", tempDir]);
		git(tempDir, "config", "user.email", "ws@example.com");
		git(tempDir, "config", "user.name", "ws");
		writeFileSync(join(tempDir, "tracked.txt"), "checkpointed\n");
		git(tempDir, "add", "-A");
		git(tempDir, "commit", "-m", "initial");

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

	/** Two turns of history; returns the first user entry and a later assistant entry. */
	async function seedTwoTurns(): Promise<{ firstAssistant: string; laterAssistant: string }> {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first question" }],
			timestamp: Date.now() - 2000,
		});
		const model = session.model!;
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1500,
		});
		const firstAssistant = [...sessionManager.getEntries()].reverse().find((e) => e.type === "message")!.id;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second question" }],
			timestamp: Date.now() - 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 500,
		});
		const laterAssistant = [...sessionManager.getEntries()].reverse().find((e) => e.type === "message")!.id;
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		return { firstAssistant, laterAssistant };
	}

	async function checkpointAt(entryId: string): Promise<void> {
		engine = (await createGitCheckpoints(tempDir, sessionManager.getSessionId(), {}))!;
		const checkpoint = await engine.capture(entryId);
		expect(checkpoint).toBeDefined();
	}

	it("keep policy (the default) never changes files", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		await checkpointAt(firstAssistant);
		writeFileSync(join(tempDir, "tracked.txt"), "edited\n");
		writeFileSync(join(tempDir, "extra.txt"), "new file\n");
		const before = git(tempDir, "status", "--porcelain", "--untracked-files=all");

		const result = await session.navigateTree(firstAssistant);
		expect(result.cancelled).toBe(false);
		expect(result.workspace).toMatchObject({ policy: "keep", outcome: "unchanged" });
		expect(git(tempDir, "status", "--porcelain", "--untracked-files=all")).toBe(before);
		expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toBe("edited\n");
	});

	it("restore brings the workspace back to the checkpoint and pins a pre-restore checkpoint", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		await checkpointAt(firstAssistant);
		writeFileSync(join(tempDir, "tracked.txt"), "edited\n");
		writeFileSync(join(tempDir, "extra.txt"), "created after checkpoint\n");

		const result = await session.navigateTree(firstAssistant, { workspacePolicy: "restore" });
		expect(result.cancelled).toBe(false);
		expect(result.workspace?.outcome).toBe("restored");
		expect(result.workspace?.preRestoreCheckpoint?.commit).toBeTruthy();
		expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toBe("checkpointed\n");
		expect(existsSync(join(tempDir, "extra.txt"))).toBe(false);
	});

	it("fail-if-drifted refuses the whole navigation when the workspace moved", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		await checkpointAt(firstAssistant);
		writeFileSync(join(tempDir, "tracked.txt"), "edited\n");
		const leafBefore = sessionManager.getLeafId();

		const result = await session.navigateTree(firstAssistant, { workspacePolicy: "fail-if-drifted" });
		expect(result.cancelled).toBe(true);
		expect(result.workspace?.outcome).toBe("refused-drifted");
		expect(sessionManager.getLeafId()).toBe(leafBefore);
		expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toBe("edited\n");
	});

	it("fail-if-drifted proceeds when the workspace still matches the checkpoint", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		await checkpointAt(firstAssistant);

		const result = await session.navigateTree(firstAssistant, { workspacePolicy: "fail-if-drifted" });
		expect(result.cancelled).toBe(false);
		expect(result.workspace?.outcome).toBe("unchanged");
		expect(sessionManager.getLeafId()).toBe(firstAssistant);
	});

	it("cancel refuses the navigation instead of changing files", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		await checkpointAt(firstAssistant);
		writeFileSync(join(tempDir, "tracked.txt"), "edited\n");
		const leafBefore = sessionManager.getLeafId();

		const result = await session.navigateTree(firstAssistant, { workspacePolicy: "cancel" });
		expect(result.cancelled).toBe(true);
		expect(result.workspace?.outcome).toBe("refused-drifted");
		expect(sessionManager.getLeafId()).toBe(leafBefore);
	});

	it("missing checkpoint leaves files unchanged and says only conversation moved", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		// No checkpoint captured for anything.
		writeFileSync(join(tempDir, "tracked.txt"), "edited\n");

		const result = await session.navigateTree(firstAssistant, { workspacePolicy: "restore" });
		expect(result.cancelled).toBe(false);
		expect(result.workspace?.outcome).toBe("missing-checkpoint");
		expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toBe("edited\n");
	});

	it("reports a failed restore honestly", async () => {
		await createSession();
		const { firstAssistant } = await seedTwoTurns();
		await checkpointAt(firstAssistant);
		writeFileSync(join(tempDir, "tracked.txt"), "edited\n");
		// Force the engine the session resolves to fail its restore.
		const failingEngine = Object.assign({}, engine, { restore: async () => undefined });
		(session as unknown as Record<string, unknown>)._checkpoints = { engine: async () => failingEngine };

		const result = await session.navigateTree(firstAssistant, { workspacePolicy: "restore" });
		expect(result.cancelled).toBe(false);
		expect(result.workspace?.outcome).toBe("failed");
		expect(result.workspace?.warnings.length).toBeGreaterThan(0);
	});
});

describe("session fork keeps the workspace untouched", () => {
	let tempDir: string;
	let runtimeHost: AgentSessionRuntime;

	afterEach(async () => {
		if (runtimeHost) await runtimeHost.dispose();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", args, { cwd, encoding: "utf-8" });
	}

	it("fork is purely conversational and changes no files", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "apex-ws-fork-"));
		mkdirSync(join(tempDir, "sessions"), { recursive: true });
		execFileSync("git", ["init", "-b", "main", tempDir]);
		git(tempDir, "config", "user.email", "ws@example.com");
		git(tempDir, "config", "user.name", "ws");
		writeFileSync(join(tempDir, "tracked.txt"), "before fork\n");
		git(tempDir, "add", "-A");
		git(tempDir, "commit", "-m", "initial");

		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "sk-test-unused" }));
		const forkModel = getModel("anthropic", "claude-sonnet-4-5")!;
		const servicesOptions = {
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager: sm,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({ ...servicesOptions, cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: sm,
					sessionStartEvent,
					model: forkModel,
					tools: [],
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtimeHost = await createAgentSessionRuntime(createRuntime, { cwd: tempDir, agentDir: tempDir, sessionManager });
		const session = runtimeHost.session;
		session.subscribe(() => {});

		const model = session.model!;
		// The session file is only created once an assistant message exists;
		// seed one turn, then the user entry the fork branches from.
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "warm-up" }],
			timestamp: Date.now() - 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "warm-up answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 500,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "fork from here" }],
			timestamp: Date.now(),
		});
		const userEntry = [...sessionManager.getEntries()].reverse().find((e) => e.type === "message")!;

		// Fork writes its own session file (conversational state); the
		// workspace fingerprint tracks only files outside the harness dirs.
		const harnessNoise = /^(.. )?(auth\.json|models-store\.json|state\.sqlite|sessions\/)/;
		const fingerprint = () =>
			git(tempDir, "status", "--porcelain", "--untracked-files=all")
				.split("\n")
				.filter((line) => line && !harnessNoise.test(line))
				.join("\n") + readFileSync(join(tempDir, "tracked.txt"), "utf-8");
		const before = fingerprint();
		const result = await runtimeHost.fork(userEntry.id);
		expect(result.cancelled).toBe(false);
		expect(fingerprint()).toBe(before);
		expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toBe("before fork\n");
	});
});
