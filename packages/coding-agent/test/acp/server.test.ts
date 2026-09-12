import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChildRunPolicySnapshot,
	ChildRunRegistry,
	type ChildSessionHandle,
	type ChildSessionStatus,
	type ChildTurnResult,
	type DelegationRuntimeOptions,
	RESUME_CHILD_PROMPT,
	runDelegation,
} from "../../src/core/delegation/runtime.ts";
import type { Capability } from "../../src/core/tools/contract.ts";
import { type AcpHost, type AcpPromptableSession, AcpServer } from "../../src/modes/acp/server.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function newCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-acp-"));
	directories.push(cwd);
	return cwd;
}

/**
 * The `resumeChildRun` pass-through semantics AgentSession owns: interrupted-only,
 * default resume prompt, observed post-turn status. The ACP tests drive the same
 * shape so the fixture stands in for the session boundary without importing it.
 */
function resumePassThrough(registry: ChildRunRegistry) {
	return async (id: string, input?: string): Promise<ChildSessionStatus> => {
		const current = registry.list().find((run) => run.handleId === id)?.status;
		if (current === undefined) throw new Error(`Unknown delegation handle "${id}".`);
		if (current !== "interrupted") throw new Error(`Child run "${id}" is not interrupted (status: ${current}).`);
		await registry.sendInput(id, input ?? RESUME_CHILD_PROMPT);
		const status = registry.list().find((run) => run.handleId === id)?.status;
		if (status === undefined) throw new Error(`Child run "${id}" disappeared while resuming.`);
		return status;
	};
}

/** Optional construction linkage fixtures, exactly like the sdk's real handles supply. */
interface ChildLinkageFixture {
	policy?: ChildRunPolicySnapshot;
}

/**
 * Minimal structural fake of the parts of AgentSession the server drives. The
 * child lifecycle methods are the exact pass-through surface RPC calls, backed by
 * a real `ChildRunRegistry` so unknown-ID rejection, list shapes, and idempotent
 * close come from production code, not from test doubles.
 */
function fakeSession(
	overrides: {
		prompt?: (text: string) => Promise<unknown>;
		child?: ChildSessionHandle;
		workspaceOwner?: DelegationRuntimeOptions["workspaceOwner"];
		linkage?: {
			getParentSessionDir?: () => string;
			getParentSessionId?: () => string;
			/** Write a child transcript under the request's artifact dir so sessionFile resolution has something to find. */
			transcriptStub?: boolean;
			/** Write a valid child transcript carrying known usage so the usage rollup has something to read. */
			usageTranscript?: boolean;
		};
	} = {},
) {
	const registry = new ChildRunRegistry();
	return {
		registry,
		prompt:
			overrides.prompt ??
			vi.fn(async () => {
				throw new Error("unexpected prompt");
			}),
		abort: vi.fn(async () => {}),
		subscribe: () => () => {},
		messages: [],
		listChildRuns: () => registry.list(),
		waitChildRun: (id: string) => registry.wait(id),
		// Mirrors AgentSession.waitChildRunResult: the awaited turn's payload with
		// the registry status after settlement; a failed settlement surfaces as an
		// outcome instead of a rejection, and the record's linkage fields ride
		// along additively when the registry snapshot knows them.
		waitChildRunResult: async (id: string) => {
			const linkageOf = () => {
				try {
					const snapshot = registry.status(id);
					return {
						...(snapshot.artifactDir !== undefined ? { artifactDir: snapshot.artifactDir } : {}),
						...(snapshot.sessionFile !== undefined ? { sessionFile: snapshot.sessionFile } : {}),
						...(snapshot.parentSessionId !== undefined ? { parentSessionId: snapshot.parentSessionId } : {}),
						...(snapshot.policy !== undefined ? { policy: snapshot.policy } : {}),
						...(snapshot.sandboxEnforced !== undefined ? { sandboxEnforced: snapshot.sandboxEnforced } : {}),
					};
				} catch {
					return {};
				}
			};
			let output: string;
			let outcome: ChildTurnResult["outcome"];
			try {
				const result = await registry.wait(id);
				output = result.output;
				outcome = result.outcome ?? "completed";
			} catch (error) {
				const status = registry.list().find((run) => run.handleId === id)?.status;
				if (status === undefined) throw error;
				return {
					status,
					output: error instanceof Error ? error.message : String(error),
					outcome: "failed" as const,
					...linkageOf(),
				};
			}
			const status = registry.list().find((run) => run.handleId === id)?.status;
			return { status: status ?? "closed", output, outcome, ...linkageOf() };
		},
		startChildRun: (
			agentType: string,
			task: string,
			request?: {
				workspace?: { isolation: "shared-read" | "worktree"; ownedPaths?: readonly string[] };
				idempotencyKey?: string;
				timeoutMs?: number;
			},
		) => {
			if (!overrides.child)
				throw new Error(
					"No delegation runtime is configured; create the session with a permission gate or options.delegation.",
				);
			// Mirrors AgentSession.startChildRun's pass-through: check the registry's
			// idempotency map first, then launch through the real delegation path.
			const existing =
				request?.idempotencyKey !== undefined
					? registry.handleForIdempotencyKey(request.idempotencyKey)
					: undefined;
			if (existing !== undefined) return Promise.resolve({ handleId: existing, created: false });
			return runDelegation(
				delegationOptions(registry, overrides.child, overrides.workspaceOwner, overrides.linkage),
				agentType,
				task,
				{
					background: true,
					workspace: request?.workspace
						? { isolation: request.workspace.isolation, ownedPaths: request.workspace.ownedPaths ?? [] }
						: undefined,
					idempotencyKey: request?.idempotencyKey,
					timeoutMs: request?.timeoutMs,
				},
			).then((result) => ({ handleId: result.handleId!, created: true }));
		},
		sendChildInput: (id: string, input: string) => registry.sendInput(id, input),
		resumeChildRun: resumePassThrough(registry),
		interruptChildRun: (id: string, reason?: string) => registry.interrupt(id, reason),
		childRunStatus: (id: string) => registry.status(id),
		closeChildRun: (id: string) => registry.close(id),
		// The explicit recovery pass-through (`agent/recover`), straight over the
		// registry like AgentSession.recoverChildWorkspace.
		recoverChildWorkspace: (id: string) => registry.recoverWorkspace(id),
	};
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
	};
	return { handle, settle: (output = defaultOutput) => resolvers.shift()!({ output }) };
}

function fakeHost(
	session: unknown,
	options: { createSession?: (cwd: string) => Promise<AcpPromptableSession> } = {},
): AcpHost {
	const promptable = session as AcpPromptableSession;
	return {
		getSession: () => promptable,
		createSession: options.createSession ?? (async () => promptable),
		loadSession: async () => promptable,
		setMode: vi.fn(async () => {}),
	};
}

/** Drive the server over in-memory streams and collect its written frames. */
function startServer(host: AcpHost) {
	const input = new PassThrough();
	const output = new PassThrough();
	const written: Array<Record<string, unknown>> = [];
	attachJsonlLineReader(output, (line) => written.push(JSON.parse(line)));
	const server = new AcpServer({ input, output, host });
	server.start();
	return {
		server,
		written,
		send: (value: Record<string, unknown>) => input.write(serializeJsonLine(value)),
		raw: input,
	};
}

const responseFor = (written: Array<Record<string, unknown>>, id: number | string) =>
	written.find((message) => message.id === id && (message.result !== undefined || message.error !== undefined));

describe("acp server dispatch", () => {
	it("routes the child lifecycle through the same session pass-throughs RPC uses, with identical result shapes", async () => {
		const session = fakeSession();
		const child = deferredChild();
		await runDelegation(delegationOptions(session.registry, child.handle), "scout", "recon the config loader", {
			background: true,
			handleId: "child-1",
		});
		const { written, send } = startServer(fakeHost(session));

		send({ jsonrpc: "2.0", id: 1, method: "agent/list", params: {} });
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		expect(responseFor(written, 1)?.result).toEqual([
			{
				handleId: "child-1",
				agentType: "scout",
				status: "running",
				task: "recon the config loader",
				attemptCount: 1,
			},
		]);

		send({ jsonrpc: "2.0", id: 2, method: "agent/wait", params: { runId: "child-1" } });
		child.settle("scout recon done");
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
		// Identical to RPC's agent/wait: the awaited turn's real result.
		expect(responseFor(written, 2)?.result).toEqual({
			status: "idle",
			output: "scout recon done",
			outcome: "completed",
		});

		send({ jsonrpc: "2.0", id: 3, method: "agent/send", params: { runId: "child-1", input: "keep going" } });
		await vi.waitFor(() => expect(child.handle.sendInput).toHaveBeenCalledWith("keep going"));
		child.settle("follow-up done");
		await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
		expect(responseFor(written, 3)?.result).toBeNull();

		send({ jsonrpc: "2.0", id: 4, method: "agent/interrupt", params: { runId: "child-1" } });
		await vi.waitFor(() => expect(responseFor(written, 4)).toBeDefined());
		expect(responseFor(written, 4)?.result).toBeNull();
		send({ jsonrpc: "2.0", id: 5, method: "agent/list", params: {} });
		await vi.waitFor(() => expect(responseFor(written, 5)).toBeDefined());
		expect(responseFor(written, 5)?.result).toEqual([
			{
				handleId: "child-1",
				agentType: "scout",
				status: "interrupted",
				task: "recon the config loader",
				attemptCount: 1,
			},
		]);

		send({ jsonrpc: "2.0", id: 6, method: "agent/resume", params: { runId: "child-1" } });
		await vi.waitFor(() => expect(child.handle.sendInput).toHaveBeenCalledWith(RESUME_CHILD_PROMPT));
		child.settle("resumed work done");
		await vi.waitFor(() => expect(responseFor(written, 6)).toBeDefined());
		// Identical to RPC's agent/resume: the observed post-turn status.
		expect(responseFor(written, 6)?.result).toEqual({ status: "idle" });
	});

	it("rejects unknown child ids on every lifecycle operation through the session pass-throughs", async () => {
		const { written, send } = startServer(fakeHost(fakeSession()));
		const cases: Array<[number, string, Record<string, unknown>]> = [
			[1, "agent/wait", { runId: "missing" }],
			[2, "agent/send", { runId: "missing", input: "x" }],
			[3, "agent/resume", { runId: "missing" }],
			[4, "agent/interrupt", { runId: "missing" }],
			[5, "agent/close", { runId: "missing" }],
		];
		for (const [id, method, params] of cases) {
			send({ jsonrpc: "2.0", id, method, params });
			await vi.waitFor(() => expect(responseFor(written, id)).toBeDefined());
			expect(responseFor(written, id)?.error).toMatchObject({ code: -32000 });
			expect((responseFor(written, id)?.error as { message: string }).message).toContain(
				'Unknown delegation handle "missing"',
			);
		}
		send({ jsonrpc: "2.0", id: 6, method: "agent/list", params: {} });
		await vi.waitFor(() => expect(responseFor(written, 6)).toBeDefined());
		expect(responseFor(written, 6)?.result).toEqual([]);
	});

	it("keeps repeated interrupt and close idempotent on the wire", async () => {
		const session = fakeSession();
		const child = deferredChild();
		await runDelegation(delegationOptions(session.registry, child.handle), "scout", "recon", {
			background: true,
			handleId: "child-1",
		});
		const { written, send } = startServer(fakeHost(session));
		send({ jsonrpc: "2.0", id: 1, method: "agent/interrupt", params: { runId: "child-1" } });
		send({ jsonrpc: "2.0", id: 2, method: "agent/interrupt", params: { runId: "child-1" } });
		send({ jsonrpc: "2.0", id: 3, method: "agent/close", params: { runId: "child-1" } });
		send({ jsonrpc: "2.0", id: 4, method: "agent/close", params: { runId: "child-1" } });
		await vi.waitFor(() => {
			for (const id of [1, 2, 3, 4]) expect(responseFor(written, id)).toBeDefined();
		});
		for (const id of [1, 2, 3, 4]) expect(responseFor(written, id)?.result).toBeNull();
		// The registry closed the child exactly once; the repeat was a no-op.
		send({ jsonrpc: "2.0", id: 5, method: "agent/list", params: {} });
		await vi.waitFor(() => expect(responseFor(written, 5)).toBeDefined());
		expect(responseFor(written, 5)?.result).toEqual([
			{ handleId: "child-1", agentType: "scout", status: "closed", task: "recon", attemptCount: 1 },
		]);
	});

	it("spawns a background child through the session and waits for its real result", async () => {
		const child = deferredChild();
		const session = fakeSession({ child: child.handle });
		const { written, send } = startServer(fakeHost(session));

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "agent/spawn",
			params: { agentType: "scout", task: "recon the config loader" },
		});
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		const spawned = responseFor(written, 1)?.result as { handleId: string };
		expect(typeof spawned.handleId).toBe("string");

		send({ jsonrpc: "2.0", id: 2, method: "agent/list", params: {} });
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
		expect(responseFor(written, 2)?.result).toEqual([
			{
				handleId: spawned.handleId,
				agentType: "scout",
				status: "running",
				task: "recon the config loader",
				attemptCount: 1,
			},
		]);

		send({ jsonrpc: "2.0", id: 3, method: "agent/wait", params: { runId: spawned.handleId } });
		child.settle("spawned recon done");
		await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
		expect(responseFor(written, 3)?.result).toEqual({
			status: "idle",
			output: "spawned recon done",
			outcome: "completed",
		});
	});

	it("agent/wait and agent/status payloads carry artifact, session file, parent, policy, and sandbox linkage", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "apex-acp-linkage-"));
		try {
			const child = deferredChild("spawned recon done", {
				policy: {
					tools: ["read"],
					capabilities: ["fs.read"],
					maxDelegationDepth: 2,
					model: "claude-sonnet-4-5",
					budgetScope: "session",
					aggregateBudget: false,
				},
			});
			const session = fakeSession({
				child: child.handle,
				linkage: {
					getParentSessionDir: () => artifactRoot,
					getParentSessionId: () => "acp-parent-session",
					transcriptStub: true,
				},
			});
			const { written, send } = startServer(fakeHost(session));

			send({
				jsonrpc: "2.0",
				id: 1,
				method: "agent/spawn",
				params: { agentType: "scout", task: "recon the config loader" },
			});
			await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
			const spawned = responseFor(written, 1)?.result as { handleId: string };

			// agent/wait: existing fields untouched, linkage fields additive.
			send({ jsonrpc: "2.0", id: 2, method: "agent/wait", params: { runId: spawned.handleId } });
			child.settle("spawned recon done");
			await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
			const waited = responseFor(written, 2)?.result as Record<string, unknown>;
			expect(waited).toMatchObject({
				status: "idle",
				output: "spawned recon done",
				outcome: "completed",
				artifactDir: join(artifactRoot, "delegations", spawned.handleId),
				parentSessionId: "acp-parent-session",
				policy: {
					tools: ["read"],
					capabilities: ["fs.read"],
					budgetScope: "session",
					aggregateBudget: false,
				},
			});
			expect(existsSync(waited.sessionFile as string)).toBe(true);
			expect((waited.sessionFile as string).endsWith(`_${spawned.handleId}.jsonl`)).toBe(true);

			// agent/status: the non-blocking snapshot carries the same linkage.
			send({ jsonrpc: "2.0", id: 3, method: "agent/status", params: { runId: spawned.handleId } });
			await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
			const status = responseFor(written, 3)?.result as Record<string, unknown>;
			expect(status).toMatchObject({
				artifactDir: join(artifactRoot, "delegations", spawned.handleId),
				parentSessionId: "acp-parent-session",
				policy: { tools: ["read"], aggregateBudget: false },
			});
			expect(existsSync(status.sessionFile as string)).toBe(true);
		} finally {
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("status payload carries tokens/cost through fixtures", async () => {
		const artifactRoot = mkdtempSync(join(tmpdir(), "apex-acp-usage-"));
		try {
			const child = deferredChild("spawned recon done");
			const session = fakeSession({
				child: child.handle,
				linkage: {
					getParentSessionDir: () => artifactRoot,
					usageTranscript: true,
				},
			});
			const { written, send } = startServer(fakeHost(session));

			send({ jsonrpc: "2.0", id: 1, method: "agent/spawn", params: { agentType: "scout", task: "recon" } });
			await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
			const spawned = responseFor(written, 1)?.result as { handleId: string };

			// The non-blocking status payload carries the transcript rollup without
			// awaiting the still-running child.
			send({ jsonrpc: "2.0", id: 2, method: "agent/status", params: { runId: spawned.handleId } });
			await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
			expect(responseFor(written, 2)?.result).toMatchObject({
				handleId: spawned.handleId,
				tokens: {
					inputTokens: 12,
					outputTokens: 34,
					cacheReadTokens: 5,
					cacheWriteTokens: 6,
					totalTokens: 57,
				},
				cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
			});
		} finally {
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("rejects agent/spawn with an actionable error when no delegation runtime is configured", async () => {
		const { written, send } = startServer(fakeHost(fakeSession()));
		send({ jsonrpc: "2.0", id: 1, method: "agent/spawn", params: { agentType: "scout", task: "recon" } });
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		expect(responseFor(written, 1)?.error).toMatchObject({ code: -32000 });
		expect((responseFor(written, 1)?.error as { message: string }).message).toContain(
			"No delegation runtime is configured",
		);
	});

	it("spawn answers created and a duplicate idempotency key returns the same handle with created false", async () => {
		const child = deferredChild();
		const session = fakeSession({ child: child.handle });
		const { written, send } = startServer(fakeHost(session));

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "agent/spawn",
			params: { agentType: "scout", task: "recon the config loader", idempotencyKey: "recon-key" },
		});
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		const spawned = responseFor(written, 1)?.result as { handleId: string; created: boolean };
		expect(spawned.created).toBe(true);
		expect(typeof spawned.handleId).toBe("string");

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "agent/spawn",
			params: { agentType: "scout", task: "recon the config loader", idempotencyKey: "recon-key" },
		});
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
		expect(responseFor(written, 2)?.result).toEqual({ handleId: spawned.handleId, created: false });

		// Exactly one child exists for the duplicated key.
		send({ jsonrpc: "2.0", id: 3, method: "agent/list", params: {} });
		await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
		expect(responseFor(written, 3)?.result).toEqual([
			{
				handleId: spawned.handleId,
				agentType: "scout",
				task: "recon the config loader",
				status: "running",
				attemptCount: 1,
			},
		]);
	});

	it("agent/status returns the task shape without blocking", async () => {
		const child = deferredChild();
		const session = fakeSession({ child: child.handle });
		const { written, send } = startServer(fakeHost(session));

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "agent/spawn",
			params: { agentType: "scout", task: "recon the config loader" },
		});
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		const spawned = responseFor(written, 1)?.result as { handleId: string };

		// No settle(): the response must arrive while the child is still running.
		send({ jsonrpc: "2.0", id: 2, method: "agent/status", params: { runId: spawned.handleId } });
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
		expect(responseFor(written, 2)?.result).toEqual({
			handleId: spawned.handleId,
			agentType: "scout",
			task: "recon the config loader",
			status: "running",
			attempts: 1,
			attempt: { id: expect.any(String) },
			workspace: { isolation: "shared-read" },
		});

		send({ jsonrpc: "2.0", id: 3, method: "agent/status", params: { runId: "missing" } });
		await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
		expect(responseFor(written, 3)?.error).toMatchObject({ code: -32000 });
		expect((responseFor(written, 3)?.error as { message: string }).message).toContain(
			'Unknown delegation handle "missing"',
		);
	});

	it("agent/interrupt carries a reason into the child status", async () => {
		const child = deferredChild();
		const session = fakeSession({ child: child.handle });
		const { written, send } = startServer(fakeHost(session));

		send({
			jsonrpc: "2.0",
			id: 1,
			method: "agent/spawn",
			params: { agentType: "scout", task: "recon" },
		});
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		const spawned = responseFor(written, 1)?.result as { handleId: string };

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "agent/interrupt",
			params: { runId: spawned.handleId, reason: "user requested stop" },
		});
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
		expect(responseFor(written, 2)?.result).toBeNull();

		send({ jsonrpc: "2.0", id: 3, method: "agent/status", params: { runId: spawned.handleId } });
		await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
		const status = responseFor(written, 3)?.result as {
			status: string;
			attempt: { outcome?: string };
			cancelled?: { reason: string; at: number };
		};
		expect(status.status).toBe("interrupted");
		expect(status.attempt.outcome).toBe("cancelled");
		expect(status.cancelled).toMatchObject({ reason: "user requested stop", at: expect.any(Number) });
	});

	it("agent/recover verifies and reactivates a worktree child, and refuses a child without one", async () => {
		const child = deferredChild();
		const root = mkdtempSync(join(tmpdir(), "apex-acp-recover-"));
		try {
			const session = fakeSession({
				child: child.handle,
				// The verification stub stands in for the real owner's read-only git
				// inspection, which the delegation runtime tests cover.
				workspaceOwner: {
					prepare: async (request) => ({ ...request, root }),
					release: async () => ({ removed: true }),
					verify: async () => ({ dirty: true }),
				},
			});
			const { written, send } = startServer(fakeHost(session));

			send({
				jsonrpc: "2.0",
				id: 1,
				method: "agent/spawn",
				params: {
					agentType: "scout",
					task: "recon the config loader",
					workspace: { isolation: "worktree", ownedPaths: [] },
				},
			});
			await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
			const spawned = responseFor(written, 1)!.result as { handleId: string };

			// agent/status carries the workspace state for a worktree child.
			send({ jsonrpc: "2.0", id: 2, method: "agent/status", params: { runId: spawned.handleId } });
			await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());
			expect(responseFor(written, 2)!.result).toMatchObject({
				workspace: { isolation: "worktree", root },
				workspaceState: "active",
			});

			// Happy path: the recovered payload matches RPC's agent/recover shape.
			send({ jsonrpc: "2.0", id: 3, method: "agent/recover", params: { runId: spawned.handleId } });
			await vi.waitFor(() => expect(responseFor(written, 3)).toBeDefined());
			expect(responseFor(written, 3)!.result).toEqual({ workspaceState: "active", dirty: true });

			// Actionable failure: a shared-read child has no workspace to recover,
			// surfacing the refusal as a -32000 error like every other operation.
			send({ jsonrpc: "2.0", id: 4, method: "agent/spawn", params: { agentType: "scout", task: "shared task" } });
			await vi.waitFor(() => expect(responseFor(written, 4)).toBeDefined());
			const shared = responseFor(written, 4)!.result as { handleId: string };
			send({ jsonrpc: "2.0", id: 5, method: "agent/recover", params: { runId: shared.handleId } });
			await vi.waitFor(() => expect(responseFor(written, 5)).toBeDefined());
			expect(responseFor(written, 5)!.error).toMatchObject({ code: -32000 });
			expect((responseFor(written, 5)!.error as { message: string }).message).toMatch(/worktree/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("answers initialize with protocol version 1, loadSession, and no auth methods", () => {
		const { server, written } = startServer(fakeHost(fakeSession()));
		server.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test-client" } },
			}),
		);

		expect(responseFor(written, 0)).toMatchObject({
			jsonrpc: "2.0",
			id: 0,
			result: {
				protocolVersion: 1,
				agentCapabilities: { loadSession: true },
				authMethods: [],
				agentInfo: { name: "apex-code" },
			},
		});
	});

	it("creates a session for session/new with the requested cwd", async () => {
		const cwd = newCwd();
		const session = fakeSession();
		const createSession = vi.fn(async (requested: string) => {
			expect(requested).toBe(cwd);
			return session;
		});
		const { written, send } = startServer(fakeHost(session, { createSession }));

		send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd, mcpServers: [] } });
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());

		expect(responseFor(written, 1)?.result).toHaveProperty("sessionId");
		expect(createSession).toHaveBeenCalledWith(cwd);
	});

	it("drives a prompt turn and answers with end_turn", async () => {
		const session = fakeSession({ prompt: vi.fn(async () => ({ stopReason: "end_turn" })) });
		const { server, written, send } = startServer(fakeHost(session));
		server.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "session/new",
				params: { cwd: newCwd(), mcpServers: [] },
			}),
		);
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		const sessionId = (responseFor(written, 1)!.result as { sessionId: string }).sessionId;

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: {
				sessionId,
				prompt: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
			},
		});
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());

		expect(session.prompt).toHaveBeenCalledWith("hello\nworld", expect.objectContaining({ source: "acp" }));
		expect(responseFor(written, 2)?.result).toEqual({ stopReason: "end_turn" });
	});

	it("maps session/cancel to the session abort path", async () => {
		const session = fakeSession();
		const { server } = startServer(fakeHost(session));
		server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } }));
		await vi.waitFor(() => expect(session.abort).toHaveBeenCalled());
	});

	it("rejects unknown methods with a JSON-RPC error", () => {
		const { written, send } = startServer(fakeHost(fakeSession()));
		send({ jsonrpc: "2.0", id: 9, method: "totally/unknown", params: {} });
		expect(responseFor(written, 9)?.error).toMatchObject({ code: -32601 });
	});

	it("ignores malformed lines without corrupting the stream", () => {
		const { server, written, send } = startServer(fakeHost(fakeSession()));
		server.handleLine("this is not json");
		send({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: 1 } });
		expect(responseFor(written, 3)).toBeDefined();
	});
});

describe("acp permission bridge", () => {
	it("round-trips request_permission to a PermissionAnswer", async () => {
		const { server, written, raw } = startServer(fakeHost(fakeSession()));
		const pending = server.askPermission("sess_1", "bash", 'Run bash commands matching "git push"');

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		expect(request.params).toMatchObject({
			sessionId: "sess_1",
			options: expect.arrayContaining([
				expect.objectContaining({ kind: "allow_once" }),
				expect.objectContaining({ kind: "allow_always" }),
				expect.objectContaining({ kind: "reject_once" }),
				expect.objectContaining({ kind: "reject_always" }),
			]),
		});

		raw.write(
			serializeJsonLine({
				jsonrpc: "2.0",
				id: request.id,
				result: { outcome: { outcome: "selected", optionId: "allow-always" } },
			}),
		);
		await expect(pending).resolves.toEqual({ allow: true, persist: true });
	});

	it("names the persisting allow for the session it actually lasts, without moving its protocol ids", async () => {
		const { server, written } = startServer(fakeHost(fakeSession()));
		server.askPermission("sess_1", "bash", "desc");

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		const options = (request.params as { options: Array<{ optionId: string; name: string; kind: string }> }).options;
		const persisting = options.find((option) => option.kind === "allow_always")!;

		// optionId and kind are the wire contract the client echoes back; only the
		// display name moves. The gate persists to `session`, never further.
		expect(persisting.optionId).toBe("allow-always");
		expect(persisting.name).toBe("Allow for this session");
		expect(persisting.name).not.toMatch(/always|permanent|forever/i);
	});

	it("answers cancelled outcomes fail-closed", async () => {
		const { server, written, raw } = startServer(fakeHost(fakeSession()));
		const pending = server.askPermission("sess_1", "bash", "desc");

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		raw.write(serializeJsonLine({ jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "cancelled" } } }));
		await expect(pending).resolves.toEqual({ allow: false });
	});

	it("omits the persisting allow when the tool would have no rule to write", async () => {
		const { server, written } = startServer(fakeHost(fakeSession()));
		server.askPermission("sess_1", "ask_user", "desc", false);

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		const options = (request.params as { options: Array<{ kind: string }> }).options;

		expect(options.some((option) => option.kind === "allow_always")).toBe(false);
		expect(options.some((option) => option.kind === "allow_once")).toBe(true);
	});

	it("omits the persisting refusal too when there would be no rule to write", async () => {
		const { server, written } = startServer(fakeHost(fakeSession()));
		server.askPermission("sess_1", "ask_user", "desc", false);

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		const options = (request.params as { options: Array<{ kind: string }> }).options;

		// A standing refusal needs a rule to stand on, exactly as a standing grant does.
		expect(options.some((option) => option.kind === "reject_always")).toBe(false);
		expect(options.some((option) => option.kind === "reject_once")).toBe(true);
	});
});
