import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { Agent } from "apex-code-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type ChildRunPolicySnapshot,
	ChildRunRegistry,
	type ChildSessionHandle,
	type ChildSessionStatus,
	type ChildTurnResult,
	type DelegationRuntimeOptions,
} from "../src/core/delegation/runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Capability } from "../src/core/tools/contract.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Optional construction linkage a fixture child may carry, exactly like the sdk's real handles. */
interface ChildLinkageFixture {
	policy?: ChildRunPolicySnapshot;
	sandboxEnforced?: boolean;
}

/** A ChildSessionHandle whose turns settle only when the test resolves them. */
function deferredChild(
	defaultOutput = "scout recon done",
	linkage?: ChildLinkageFixture,
): {
	handle: ChildSessionHandle;
	settle: (output?: string) => void;
} {
	let latest: ChildTurnResult | undefined;
	let status: ChildSessionStatus = "idle";
	const resolvers: Array<(value: { output: string }) => void> = [];
	const startTurn = () =>
		new Promise<{ output: string }>((resolve) => {
			resolvers.push((value) => {
				latest = { outcome: "completed", output: value.output };
				status = "idle";
				resolve(value);
			});
			status = "running";
		});
	const initial = startTurn();
	const handle: ChildSessionHandle = {
		get status() {
			return status;
		},
		run: () => initial,
		latestResult: () => latest,
		wait: async () => {},
		interrupt: () => {
			status = "interrupted";
		},
		close: () => {
			status = "closed";
		},
		sendInput: vi.fn((_input: string) => startTurn().then(() => undefined)),
		followUp: async () => {},
		dispose: () => {},
		...(linkage?.policy ? { policy: linkage.policy } : {}),
		...(linkage?.sandboxEnforced !== undefined ? { sandboxEnforced: linkage.sandboxEnforced } : {}),
	};
	return { handle, settle: (output = defaultOutput) => resolvers.shift()!({ output }) };
}

/** Known faux usage, chosen so the rollup expectation is exact. */
const USAGE_FIXTURE = {
	input: 12,
	output: 34,
	cacheRead: 5,
	cacheWrite: 6,
	totalTokens: 57,
	cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
};

/**
 * A minimal VALID child transcript (header + one assistant turn) whose usage
 * is known, so the registry's rollup has something real to read.
 */
function writeUsageTranscript(artifactDir: string, sessionId: string): void {
	const now = new Date().toISOString();
	const header = { type: "session", version: 3, id: sessionId, timestamp: now, cwd: artifactDir };
	const entry = {
		type: "message",
		id: "usage-entry-1",
		parentId: null,
		timestamp: now,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "recon complete" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: USAGE_FIXTURE,
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
	writeFileSync(
		join(artifactDir, `0000000000_${sessionId}.jsonl`),
		`${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
		"utf-8",
	);
}

/** Runtime options that launch the supplied fixture child through the real delegation path. */
function delegationOptions(
	registry: ChildRunRegistry,
	child: ChildSessionHandle,
	workspaceOwner?: DelegationRuntimeOptions["workspaceOwner"],
	linkage?: {
		getParentSessionDir?: () => string;
		getParentSessionId?: () => string;
		/** Write a child transcript under the request's artifact dir so sessionFile resolution has something to find. */
		transcriptStub?: boolean;
		/** Write a valid child transcript carrying known usage so the usage rollup has something to read. */
		usageTranscript?: boolean;
	},
): DelegationRuntimeOptions {
	return {
		resolveAgent: (agentType) =>
			agentType === "scout"
				? { name: "scout", description: "Fast recon", tools: [], systemPrompt: "You are a scout." }
				: undefined,
		getParentCapabilities: () => new Set<Capability>(["delegate"]),
		getToolCapabilities: () => new Set<Capability>(),
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		childRunRegistry: registry,
		buildChildSession: async (request) => {
			if (linkage?.transcriptStub && request.artifactDir) {
				writeFileSync(join(request.artifactDir, `0000000000_${request.sessionId}.jsonl`), "{}\n", "utf-8");
			}
			if (linkage?.usageTranscript && request.artifactDir) {
				writeUsageTranscript(request.artifactDir, request.sessionId);
			}
			return child;
		},
		...(workspaceOwner ? { workspaceOwner } : {}),
		...(linkage?.getParentSessionDir ? { getParentSessionDir: linkage.getParentSessionDir } : {}),
		...(linkage?.getParentSessionId ? { getParentSessionId: linkage.getParentSessionId } : {}),
	};
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	child?: ChildSessionHandle;
	workspaceOwner?: DelegationRuntimeOptions["workspaceOwner"];
	childLinkage?: {
		getParentSessionDir?: () => string;
		getParentSessionId?: () => string;
		transcriptStub?: boolean;
		usageTranscript?: boolean;
	};
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const childRunRegistry = options.child ? new ChildRunRegistry() : undefined;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
		childRunRegistry,
		delegationRuntime:
			options.child && childRunRegistry
				? delegationOptions(childRunRegistry, options.child, options.workspaceOwner, options.childLinkage)
				: undefined,
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	child?: ChildSessionHandle;
	workspaceOwner?: DelegationRuntimeOptions["workspaceOwner"];
	childLinkage?: {
		getParentSessionDir?: () => string;
		getParentSessionId?: () => string;
		transcriptStub?: boolean;
		usageTranscript?: boolean;
	};
}): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
					},
				});
			});

			await sleep(600);
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("routes the child lifecycle commands through the session pass-throughs", async () => {
		// The harness session has no child-run registry, which is itself the wiring
		// check: `agent/list` still answers from session.listChildRuns(), and
		// `agent/resume` (same six-operation surface as ACP) fails with the
		// session's own registry error instead of "unknown command".
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "agents-list", type: "agent/list" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "agents-list",
					type: "response",
					command: "agent/list",
					success: true,
					data: [],
				});
			});

			lineHandler(JSON.stringify({ id: "agents-resume", type: "agent/resume", childId: "missing" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "agents-resume",
					type: "response",
					command: "agent/resume",
					success: false,
					error: "Child run registry is unavailable.",
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("spawn, wait, and list return real child payloads", async () => {
		const child = deferredChild();
		let spawnedHandleId = "";
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0, child: child.handle });

		try {
			lineHandler(
				JSON.stringify({ id: "spawn-1", type: "agent/spawn", agentType: "scout", task: "recon the config loader" }),
			);
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "spawn-1");
				expect(responses).toHaveLength(1);
				const handleId = (responses[0] as { data?: { handleId?: string } }).data?.handleId;
				expect(typeof handleId).toBe("string");
				spawnedHandleId = handleId!;
			});

			lineHandler(JSON.stringify({ id: "list-1", type: "agent/list" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "list-1",
					type: "response",
					command: "agent/list",
					success: true,
					data: [
						{
							handleId: spawnedHandleId,
							agentType: "scout",
							status: "running",
							task: "recon the config loader",
							attemptCount: 1,
						},
					],
				});
			});

			lineHandler(JSON.stringify({ id: "wait-1", type: "agent/wait", childId: spawnedHandleId }));
			child.settle("scout recon over the wire");
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "wait-1",
					type: "response",
					command: "agent/wait",
					success: true,
					data: { status: "idle", output: "scout recon over the wire", outcome: "completed" },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("agent/wait and agent/status carry the child's artifact, session file, parent, policy, and sandbox linkage", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "apex-rpc-linkage-"));
		const child = deferredChild("scout recon over the wire", {
			policy: {
				tools: ["read"],
				capabilities: ["fs.read"],
				sandbox: "none",
				maxDelegationDepth: 2,
				model: "claude-sonnet-4-5",
				budgetScope: "session",
				aggregateBudget: false,
			},
			sandboxEnforced: true,
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			child: child.handle,
			childLinkage: {
				getParentSessionDir: () => artifactRoot,
				getParentSessionId: () => "rpc-parent-session",
				transcriptStub: true,
			},
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "linkage-spawn",
					type: "agent/spawn",
					agentType: "scout",
					task: "recon the config loader",
				}),
			);
			let spawnedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "linkage-spawn");
				expect(responses).toHaveLength(1);
				spawnedHandleId = (responses[0] as { data?: { handleId?: string } }).data?.handleId ?? "";
				expect(spawnedHandleId).toBeTruthy();
			});

			lineHandler(JSON.stringify({ id: "linkage-wait", type: "agent/wait", childId: spawnedHandleId }));
			child.settle("scout recon over the wire");
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "linkage-wait");
				expect(responses).toHaveLength(1);
				const data = (responses[0] as { data?: Record<string, unknown> }).data!;
				// Existing wait fields are untouched; the linkage is additive.
				expect(data).toMatchObject({
					status: "idle",
					output: "scout recon over the wire",
					outcome: "completed",
					artifactDir: join(artifactRoot, "delegations", spawnedHandleId),
					parentSessionId: "rpc-parent-session",
					policy: { tools: ["read"], capabilities: ["fs.read"], sandbox: "none", budgetScope: "session" },
					sandboxEnforced: true,
				});
				const sessionFile = data.sessionFile as string | undefined;
				expect(typeof sessionFile).toBe("string");
				expect(existsSync(sessionFile!)).toBe(true);
				expect(sessionFile!.endsWith(`_${spawnedHandleId}.jsonl`)).toBe(true);
			});

			lineHandler(JSON.stringify({ id: "linkage-status", type: "agent/status", childId: spawnedHandleId }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "linkage-status");
				expect(responses).toHaveLength(1);
				const data = (responses[0] as { data?: Record<string, unknown> }).data!;
				expect(data).toMatchObject({
					handleId: spawnedHandleId,
					artifactDir: join(artifactRoot, "delegations", spawnedHandleId),
					parentSessionId: "rpc-parent-session",
					policy: { tools: ["read"], sandbox: "none", aggregateBudget: false },
					sandboxEnforced: true,
				});
				expect(existsSync(data.sessionFile as string)).toBe(true);
			});
		} finally {
			await cleanup();
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("status payload carries tokens/cost through fixtures", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "apex-rpc-usage-"));
		const child = deferredChild("scout recon over the wire");
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			child: child.handle,
			childLinkage: {
				getParentSessionDir: () => artifactRoot,
				usageTranscript: true,
			},
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "usage-spawn",
					type: "agent/spawn",
					agentType: "scout",
					task: "recon the config loader",
				}),
			);
			let spawnedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "usage-spawn");
				expect(responses).toHaveLength(1);
				spawnedHandleId = (responses[0] as { data?: { handleId?: string } }).data?.handleId ?? "";
				expect(spawnedHandleId).toBeTruthy();
			});

			// The non-blocking status payload carries the transcript rollup without
			// awaiting the still-running child.
			lineHandler(JSON.stringify({ id: "usage-status", type: "agent/status", childId: spawnedHandleId }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "usage-status");
				expect(responses).toHaveLength(1);
				expect((responses[0] as { data?: Record<string, unknown> }).data).toMatchObject({
					handleId: spawnedHandleId,
					tokens: {
						inputTokens: 12,
						outputTokens: 34,
						cacheReadTokens: 5,
						cacheWriteTokens: 6,
						totalTokens: 57,
					},
					cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
				});
			});
		} finally {
			await cleanup();
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("agent/spawn fails with an actionable error when no delegation runtime is configured", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "spawn-none", type: "agent/spawn", agentType: "scout", task: "recon" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "spawn-none",
					type: "response",
					command: "agent/spawn",
					success: false,
					error: expect.stringContaining("No delegation runtime is configured"),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("spawn returns created and a duplicate idempotency key returns the same handle with created false", async () => {
		const child = deferredChild();
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0, child: child.handle });

		try {
			lineHandler(
				JSON.stringify({
					id: "spawn-idem-1",
					type: "agent/spawn",
					agentType: "scout",
					task: "recon the config loader",
					idempotencyKey: "recon-key",
				}),
			);
			let spawnedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "spawn-idem-1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ command: "agent/spawn", success: true, data: { created: true } });
				spawnedHandleId = (responses[0] as { data?: { handleId?: string } }).data!.handleId!;
				expect(typeof spawnedHandleId).toBe("string");
			});

			lineHandler(
				JSON.stringify({
					id: "spawn-idem-2",
					type: "agent/spawn",
					agentType: "scout",
					task: "recon the config loader",
					idempotencyKey: "recon-key",
				}),
			);
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "spawn-idem-2",
					type: "response",
					command: "agent/spawn",
					success: true,
					data: { handleId: spawnedHandleId, created: false },
				});
			});
			// Exactly one child exists for the duplicated key.
			lineHandler(JSON.stringify({ id: "spawn-idem-list", type: "agent/list" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "spawn-idem-list",
					type: "response",
					command: "agent/list",
					success: true,
					data: [
						{
							handleId: spawnedHandleId,
							agentType: "scout",
							task: "recon the config loader",
							status: "running",
							attemptCount: 1,
						},
					],
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("agent/status returns the task shape without blocking", async () => {
		const child = deferredChild();
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0, child: child.handle });

		try {
			lineHandler(
				JSON.stringify({
					id: "status-spawn",
					type: "agent/spawn",
					agentType: "scout",
					task: "recon the config loader",
				}),
			);
			let spawnedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "status-spawn");
				expect(responses).toHaveLength(1);
				spawnedHandleId = (responses[0] as { data?: { handleId?: string } }).data!.handleId!;
			});

			// No settle(): the response must arrive while the child is still running.
			lineHandler(JSON.stringify({ id: "status-1", type: "agent/status", childId: spawnedHandleId }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "status-1",
					type: "response",
					command: "agent/status",
					success: true,
					data: {
						handleId: spawnedHandleId,
						agentType: "scout",
						task: "recon the config loader",
						status: "running",
						attempts: 1,
						attempt: { id: expect.any(String) },
						workspace: { isolation: "shared-read" },
					},
				});
			});

			lineHandler(JSON.stringify({ id: "status-missing", type: "agent/status", childId: "missing" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "status-missing",
					type: "response",
					command: "agent/status",
					success: false,
					error: expect.stringContaining('Unknown delegation handle "missing"'),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("interrupt carries a reason into the child status", async () => {
		const child = deferredChild();
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0, child: child.handle });

		try {
			lineHandler(JSON.stringify({ id: "interrupt-spawn", type: "agent/spawn", agentType: "scout", task: "recon" }));
			let spawnedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "interrupt-spawn");
				expect(responses).toHaveLength(1);
				spawnedHandleId = (responses[0] as { data?: { handleId?: string } }).data!.handleId!;
			});

			lineHandler(
				JSON.stringify({
					id: "interrupt-1",
					type: "agent/interrupt",
					childId: spawnedHandleId,
					reason: "user requested stop",
				}),
			);
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "interrupt-1",
					type: "response",
					command: "agent/interrupt",
					success: true,
				});
			});

			lineHandler(JSON.stringify({ id: "interrupt-status", type: "agent/status", childId: spawnedHandleId }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "interrupt-status");
				expect(responses).toHaveLength(1);
				const data = (responses[0] as { data?: Record<string, unknown> }).data!;
				expect(data).toMatchObject({
					handleId: spawnedHandleId,
					status: "interrupted",
					attempt: { outcome: "cancelled" },
					cancelled: { reason: "user requested stop" },
				});
				expect((data.cancelled as { at: number }).at).toEqual(expect.any(Number));
			});
		} finally {
			await cleanup();
		}
	});

	it("agent/recover verifies and reactivates a worktree child, and refuses a child without one", async () => {
		const child = deferredChild();
		const root = mkdtempSync(join(tmpdir(), "apex-rpc-recover-"));
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			child: child.handle,
			workspaceOwner: {
				prepare: async (request) => ({ ...request, root }),
				release: async () => ({ removed: true }),
				// The verification stub stands in for the real owner's read-only git
				// inspection, which the delegation runtime tests cover.
				verify: async () => ({ dirty: false }),
			},
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "recover-spawn",
					type: "agent/spawn",
					agentType: "scout",
					task: "recon the config loader",
					workspace: { isolation: "worktree", ownedPaths: [] },
				}),
			);
			let spawnedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "recover-spawn");
				expect(responses).toHaveLength(1);
				spawnedHandleId = (responses[0] as { data?: { handleId?: string } }).data!.handleId!;
			});

			// agent/status carries the workspace state for a worktree child.
			lineHandler(JSON.stringify({ id: "recover-status", type: "agent/status", childId: spawnedHandleId }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "recover-status");
				expect(responses).toHaveLength(1);
				expect((responses[0] as { data?: Record<string, unknown> }).data).toMatchObject({
					workspace: { isolation: "worktree", root },
					workspaceState: "active",
				});
			});

			// Happy path: explicit recovery verifies through the owner and reports
			// the reactivated workspace state with its dirty flag.
			lineHandler(JSON.stringify({ id: "recover-1", type: "agent/recover", childId: spawnedHandleId }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "recover-1",
					type: "response",
					command: "agent/recover",
					success: true,
					data: { workspaceState: "active", dirty: false },
				});
			});

			// Actionable failure: a shared-read child has no workspace to recover,
			// and the refusal names the failed precondition.
			lineHandler(
				JSON.stringify({
					id: "recover-spawn-shared",
					type: "agent/spawn",
					agentType: "scout",
					task: "shared task",
				}),
			);
			let sharedHandleId = "";
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "recover-spawn-shared");
				expect(responses).toHaveLength(1);
				sharedHandleId = (responses[0] as { data?: { handleId?: string } }).data!.handleId!;
			});
			lineHandler(JSON.stringify({ id: "recover-2", type: "agent/recover", childId: sharedHandleId }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter((r) => r.id === "recover-2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ command: "agent/recover", success: false });
				expect((responses[0] as { error?: string }).error).toMatch(/worktree/i);
			});
		} finally {
			await cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
