import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
	AgentDefinition,
	BuildChildSessionRequest,
	ChildRunRecord,
	ChildSessionHandle,
	ChildSessionStatus,
	ChildTurnResult,
	DelegationRuntimeOptions,
} from "../../src/core/delegation/runtime.ts";
import { ChildRunRegistry, retrieveDelegationResult, runDelegation } from "../../src/core/delegation/runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Capability } from "../../src/core/tools/contract.ts";
import { GitWorktreeWorkspaceOwner } from "../../src/core/workspace/git-worktree-owner.ts";

function caps(...values: Capability[]): ReadonlySet<Capability> {
	return new Set(values);
}

/** Known faux provider usage, chosen so sums are exact in binary floating point. */
const USAGE_A = {
	input: 100,
	output: 10,
	cacheRead: 5,
	cacheWrite: 7,
	totalTokens: 122,
	cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
};
const USAGE_B = {
	input: 30,
	output: 4,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 37,
	cost: { input: 0.25, output: 0.125, cacheRead: 0.0625, cacheWrite: 0.03125, total: 0.46875 },
};
/** USAGE_A + USAGE_B, in the rollup's shape. */
const USAGE_SUM_AB = {
	inputTokens: 130,
	outputTokens: 14,
	cacheReadTokens: 7,
	cacheWriteTokens: 8,
	totalTokens: 159,
	cost: { input: 0.75, output: 0.375, cacheRead: 0.1875, cacheWrite: 0.09375, total: 1.40625 },
};

function usageAssistantMessage(text: string, usage: typeof USAGE_A) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** Write a two-turn child transcript with known usage under `artifactDir`; returns the file path. */
function writeUsageTranscript(artifactDir: string, sessionId: string): string {
	const child = SessionManager.create(process.cwd(), artifactDir, { id: sessionId });
	child.appendMessage(usageAssistantMessage("scout turn one", USAGE_A));
	child.appendMessage(usageAssistantMessage("scout turn two", USAGE_B));
	const file = child.getSessionFile();
	if (!file) throw new Error("expected a file-backed child transcript");
	return file;
}

function scoutDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "scout",
		description: "Fast recon",
		tools: ["read"],
		systemPrompt: "You are a scout.",
		...overrides,
	};
}

function fakeChild(output = "scout output"): {
	handle: ChildSessionHandle;
	run: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setLatest: (result: ChildTurnResult | undefined) => void;
} {
	let latest: ChildTurnResult | undefined;
	const run = vi.fn(async () => {
		latest = { outcome: "completed", output };
		return { output };
	});
	const dispose = vi.fn();
	return {
		handle: {
			run,
			dispose,
			close: dispose,
			interrupt: vi.fn(),
			wait: async () => {},
			sendInput: vi.fn(async () => {
				latest = { outcome: "completed", output };
			}),
			followUp: async () => {},
			status: "idle",
			latestResult: () => latest,
		},
		run,
		dispose,
		setLatest: (result) => {
			latest = result;
		},
	};
}

function baseOptions(overrides: Partial<DelegationRuntimeOptions> = {}): DelegationRuntimeOptions {
	return {
		resolveAgent: (agentType) => (agentType === "scout" ? scoutDefinition() : undefined),
		getParentCapabilities: () => caps("fs.read", "delegate"),
		getToolCapabilities: (toolName) =>
			toolName === "read" ? caps("fs.read") : toolName === "bash" ? caps("exec") : undefined,
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		buildChildSession: vi.fn(async () => fakeChild().handle),
		...overrides,
	};
}

/** A ChildSessionHandle whose initial turn settles only when the test resolves it (used for running-child states). */
function deferredChild(defaultOutput = "deferred output"): {
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
	return {
		handle: {
			get status() {
				return status;
			},
			run: () => initial,
			latestResult: () => latest,
			wait: async () => {},
			interrupt: vi.fn(() => {
				status = "interrupted";
			}),
			close: () => {
				status = "closed";
			},
			sendInput: () => startTurn().then(() => undefined),
			followUp: async () => {},
			dispose: () => {},
		},
		settle: (output = defaultOutput) => resolvers.shift()!({ output }),
	};
}

describe("runDelegation", () => {
	it("persists child_run entries in a file-backed parent across registry lifecycle transitions", () => {
		const scratch = mkdtempSync(join(tmpdir(), "apex-child-run-"));
		try {
			const parent = SessionManager.create(scratch, scratch);
			const sessionPath = parent.getSessionFile();
			expect(sessionPath).toBeDefined();
			parent.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "session initialized" }],
				api: "test",
				provider: "test",
				model: "test",
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
			});
			const registry = new ChildRunRegistry();
			const persist = (record: ChildRunRecord) => parent.appendCustomEntry("child_run", record);
			registry.setPersistence(persist);
			persist({
				handleId: "run-1",
				agentType: "scout",
				sessionId: "run-1",
				task: "one",
				status: "completed",
				updatedAt: Date.now(),
			});
			registry.dispose();
			expect(existsSync(sessionPath!)).toBe(true);
			const reopened = SessionManager.open(sessionPath!);
			expect(reopened.getEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "custom",
						customType: "child_run",
						data: expect.objectContaining({
							handleId: "run-1",
							agentType: "scout",
							sessionId: "run-1",
							task: "one",
							status: "completed",
						}),
					}),
				]),
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	it("rejects canonical overlapping ownership claims and permits shared reads", async () => {
		const registry = new ChildRunRegistry();
		const child = fakeChild();
		const options = baseOptions({ childRunRegistry: registry, buildChildSession: vi.fn(async () => child.handle) });
		const root = "/tmp/apex-workspace";
		await runDelegation(options, "scout", "one", {
			background: true,
			workspace: { isolation: "shared-read", ownedPaths: [`${root}/src/../src`] },
		});
		await expect(
			runDelegation(options, "scout", "two", {
				workspace: { isolation: "shared-read", ownedPaths: [`${root}/src/file`] },
			}),
		).rejects.toThrow(/overlaps/);
		await expect(
			runDelegation(options, "scout", "three", {
				workspace: { isolation: "shared-read", ownedPaths: [] },
			}),
		).resolves.toMatchObject({ output: "scout output" });
	});

	it("refuses worktree isolation without a workspace owner", async () => {
		await expect(
			runDelegation(baseOptions(), "scout", "task", {
				workspace: { isolation: "worktree", ownedPaths: ["/tmp/apex-workspace"] },
			}),
		).rejects.toThrow(/no workspace owner/i);
	});

	it("does not launch a child whose construction finishes after parent disposal", async () => {
		const child = fakeChild();
		let finish!: (handle: ChildSessionHandle) => void;
		const registry = new ChildRunRegistry();
		const options = baseOptions({
			childRunRegistry: registry,
			buildChildSession: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const result = runDelegation(options, "scout", "task");
		registry.dispose();
		finish(child.handle);
		await expect(result).rejects.toThrow(/disposed/i);
		expect(child.run).not.toHaveBeenCalled();
		expect(child.dispose).toHaveBeenCalledTimes(1);
	});

	it("rejects new children after parent disposal before constructing them", async () => {
		const registry = new ChildRunRegistry();
		const options = baseOptions({ childRunRegistry: registry });
		registry.dispose();
		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/disposed/i);
		expect(options.buildChildSession).not.toHaveBeenCalled();
	});
	it("runs the child and returns its output on the happy path", async () => {
		const { handle, run, dispose } = fakeChild("found it in config.ts");
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({ buildChildSession });

		const result = await runDelegation(options, "scout", "find the config loader");

		expect(result).toEqual({ agentType: "scout", task: "find the config loader", output: "found it in config.ts" });
		expect(run).toHaveBeenCalledWith("find the config loader");
		expect(dispose).not.toHaveBeenCalled();
		options.childRunRegistry!.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("passes the definition's exact tool list to buildChildSession -- never taken from anywhere else", async () => {
		const { handle } = fakeChild();
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({
			resolveAgent: () => scoutDefinition({ tools: ["read", "grep"] }),
			getToolCapabilities: (toolName) =>
				toolName === "read" ? caps("fs.read") : toolName === "grep" ? caps("fs.read") : undefined,
			buildChildSession,
		});

		await runDelegation(options, "scout", "task");

		expect(buildChildSession).toHaveBeenCalledWith(
			expect.objectContaining({ agentType: "scout", toolNames: ["read", "grep"] }),
		);
	});

	it("throws for an unknown agent type and never builds a child", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({ resolveAgent: () => undefined, buildChildSession });

		await expect(runDelegation(options, "ghost", "task")).rejects.toThrow(/unknown agent type/i);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("throws for a definition naming an unknown tool and never builds a child", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({
			resolveAgent: () => scoutDefinition({ tools: ["nonexistent_tool"] }),
			getToolCapabilities: () => undefined,
			buildChildSession,
		});

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/unknown tool/i);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("refuses a definition naming bash under a parent without exec, naming the capability, and never yields a child holding bash", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({
			// Parent's own authority: fs.read + delegate only. No exec anywhere.
			getParentCapabilities: () => caps("fs.read", "delegate"),
			resolveAgent: () => scoutDefinition({ name: "worker", tools: ["read", "bash"] }),
			buildChildSession,
		});

		await expect(runDelegation(options, "worker", "run tests")).rejects.toThrow(/exec/);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("admits a request when the parent holds exec (escalation rule, contracts.md §1.1)", async () => {
		const { handle } = fakeChild("ran the tests");
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({
			getParentCapabilities: () => caps("exec"),
			resolveAgent: () => scoutDefinition({ name: "worker", tools: ["read", "bash"] }),
			buildChildSession,
		});

		const result = await runDelegation(options, "worker", "run tests");
		expect(result.output).toBe("ran the tests");
	});

	it("passes the parent depth + 1 to buildChildSession as the child's depth", async () => {
		const { handle } = fakeChild();
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({ getDelegationDepth: () => 1, maxDelegationDepth: 5, buildChildSession });

		await runDelegation(options, "scout", "task");

		expect(buildChildSession).toHaveBeenCalledWith(expect.objectContaining({ depth: 2 }));
	});

	it("refuses to delegate at the depth bound, naming the bound, and never builds a child", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({ getDelegationDepth: () => 2, maxDelegationDepth: 2, buildChildSession });

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/depth/i);
		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/2/);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("refuses past the depth bound too, not only exactly at it", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({ getDelegationDepth: () => 5, maxDelegationDepth: 2, buildChildSession });

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/depth/i);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("still admits delegation one level below the bound", async () => {
		const { handle } = fakeChild("ok");
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({ getDelegationDepth: () => 1, maxDelegationDepth: 2, buildChildSession });

		const result = await runDelegation(options, "scout", "task");
		expect(result.output).toBe("ok");
	});

	it("returns a handle immediately for a background child and retrieves its result after completion", async () => {
		let release: (() => void) | undefined;
		const completed = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = vi.fn(async () => {
			await completed;
			return { output: "finished later" };
		});
		const dispose = vi.fn();
		const child: ChildSessionHandle = {
			run,
			dispose,
			close: dispose,
			interrupt: vi.fn(),
			wait: async () => {},
			sendInput: async () => {},
			followUp: async () => {},
			status: "idle",
			latestResult: () => undefined,
		};
		const options = baseOptions({ buildChildSession: vi.fn(async () => child) });
		const started = await runDelegation(options, "scout", "task", { background: true });
		expect(started.handleId).toBeTruthy();
		expect(started.output).toMatch(/started/i);
		const retrieved = retrieveDelegationResult(options, started.handleId!, "scout");
		expect(run).toHaveBeenCalledWith("task");
		release?.();
		await expect(retrieved).resolves.toEqual({
			agentType: "scout",
			task: "task",
			output: "finished later",
			outcome: "completed",
		});
		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toEqual({
			agentType: "scout",
			task: "task",
			output: "finished later",
			outcome: "completed",
		});
	});

	it("rejects retrieval of an unknown background handle", async () => {
		await expect(retrieveDelegationResult(baseOptions(), "missing")).rejects.toThrow(/unknown delegation handle/i);
	});

	it("creates a unique child artifact directory below the parent session directory before building the child", async () => {
		const { mkdtemp, rm, stat } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const parentDir = await mkdtemp(join(tmpdir(), "apex-delegation-artifacts-"));
		try {
			const { handle } = fakeChild();
			const buildChildSession = vi.fn<DelegationRuntimeOptions["buildChildSession"]>(async () => handle);
			await runDelegation(baseOptions({ getParentSessionDir: () => parentDir, buildChildSession }), "scout", "task");
			const request = buildChildSession.mock.calls[0]?.[0];
			expect(
				request?.artifactDir?.startsWith(
					`${join(parentDir, "delegations")}${process.platform === "win32" ? "\\" : "/"}`,
				),
			).toBe(true);
			expect(request?.sessionId).toBeTruthy();
			expect((await stat(request?.artifactDir ?? "")).isDirectory()).toBe(true);
		} finally {
			await rm(parentDir, { recursive: true, force: true });
		}
	});

	it("retains a failed child until the parent disposes it", async () => {
		const dispose = vi.fn();
		const run = vi.fn(async () => {
			throw new Error("child crashed");
		});
		const buildChildSession = vi.fn(
			async () =>
				({
					run,
					dispose,
					close: dispose,
					interrupt: vi.fn(),
					wait: async () => {},
					sendInput: async () => {},
					followUp: async () => {},
					status: "idle",
					latestResult: () => undefined,
				}) as ChildSessionHandle,
		);
		const options = baseOptions({ buildChildSession });

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/child crashed/);
		expect(dispose).not.toHaveBeenCalled();
		options.childRunRegistry!.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});

describe("ChildRunRegistry", () => {
	it("registers stable entries, ignores duplicate IDs, and retrieves the first entry's result", async () => {
		const registry = new ChildRunRegistry();
		const first = Promise.resolve({ agentType: "scout", task: "first", output: "one" });
		const second = Promise.resolve({ agentType: "scout", task: "second", output: "two" });
		registry.register("child-1", { agentType: "scout", task: "first", promise: first });
		registry.register("child-1", { agentType: "scout", task: "second", promise: second });
		await expect(registry.retrieve("child-1")).resolves.toEqual({
			agentType: "scout",
			task: "first",
			output: "one",
			outcome: "completed",
		});
	});

	it("retrieves the same result while pending and after completion", async () => {
		const registry = new ChildRunRegistry();
		let resolveResult!: (value: { agentType: string; task: string; output: string }) => void;
		const promise = new Promise<{ agentType: string; task: string; output: string }>((resolve) => {
			resolveResult = resolve;
		});
		registry.register("pending", { agentType: "scout", task: "task", promise });
		const pendingRetrieval = registry.retrieve("pending", "scout");
		resolveResult({ agentType: "scout", task: "task", output: "done" });
		const settled = await pendingRetrieval;
		await expect(registry.retrieve("pending", "scout")).resolves.toEqual(settled);
	});

	it("rejects unknown IDs and agent type mismatches", () => {
		const registry = new ChildRunRegistry();
		registry.register("known", {
			agentType: "scout",
			task: "task",
			promise: Promise.resolve({ agentType: "scout", task: "task", output: "done" }),
		});
		expect(() => registry.retrieve("missing")).toThrow(/unknown delegation handle/i);
		expect(() => registry.retrieve("known", "worker")).toThrow(/belongs to agent "scout"/i);
	});
});

describe("background retrieval follows the latest turn", () => {
	it("returns the latest turn's output when waiting after sendInput, not the initial text", async () => {
		const child = fakeChild("initial output");
		child.handle.sendInput = vi.fn(async () => {
			child.setLatest({ outcome: "completed", output: "follow-up output" });
		});
		const options = baseOptions({ buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "task", { background: true });
		const registry = options.childRunRegistry!;
		await expect(registry.wait(started.handleId!)).resolves.toEqual({
			agentType: "scout",
			task: "task",
			output: "initial output",
			outcome: "completed",
		});

		await registry.sendInput(started.handleId!, "go deeper");

		await expect(registry.wait(started.handleId!)).resolves.toEqual({
			agentType: "scout",
			task: "task",
			output: "follow-up output",
			outcome: "completed",
		});
		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toMatchObject({
			output: "follow-up output",
		});
		registry.dispose();
	});

	it("surfaces an interrupted first turn as an interrupted outcome instead of re-raising the rejection", async () => {
		const child = fakeChild();
		child.handle.run = vi.fn(async () => {
			child.setLatest({ outcome: "interrupted", output: "partial answer" });
			throw new Error("Child session was interrupted.");
		});
		const options = baseOptions({ buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "task", { background: true });

		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toEqual({
			agentType: "scout",
			task: "task",
			output: "partial answer",
			outcome: "interrupted",
		});
		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toEqual({
			agentType: "scout",
			task: "task",
			output: "partial answer",
			outcome: "interrupted",
		});
		options.childRunRegistry!.dispose();
	});

	it("rethrows a failed turn's error on retrieval", async () => {
		const child = fakeChild();
		child.handle.run = vi.fn(async () => {
			child.setLatest({ outcome: "failed", output: "child crashed" });
			throw new Error("child crashed");
		});
		const options = baseOptions({ buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "task", { background: true });

		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).rejects.toThrow(/child crashed/);
		options.childRunRegistry!.dispose();
	});

	it("marks a failed child in its records without any explicit wait (ported from the deleted RunService facade)", async () => {
		const persisted: ChildRunRecord[] = [];
		const registry = new ChildRunRegistry();
		registry.setPersistence((record) => persisted.push(record));
		const child = fakeChild();
		let failChild!: (error: Error) => void;
		child.handle.run = vi.fn(
			() =>
				new Promise<{ output: string }>((_resolve, reject) => {
					failChild = reject;
				}),
		);
		const options = baseOptions({ childRunRegistry: registry, buildChildSession: async () => child.handle });
		await runDelegation(options, "scout", "task", { background: true });
		failChild(new Error("child failed"));
		// No wait/retrieve call: the registry observes the settlement itself.
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
		expect(persisted[persisted.length - 1]).toMatchObject({ handleId: expect.any(String), status: "failed" });
		registry.dispose();
	});

	it("accepts input immediately after awaited startup with asynchronous child construction (ported from the deleted RunService facade)", async () => {
		const child = fakeChild();
		const buildChildSession = vi.fn(async () => {
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
			return child.handle;
		});
		const options = baseOptions({ buildChildSession });
		const started = await runDelegation(options, "scout", "task", { background: true });
		// The awaited startup guarantees the handle is registered and ready for input.
		await expect(options.childRunRegistry!.sendInput(started.handleId!, "include tests")).resolves.toBeUndefined();
		expect(child.handle.sendInput).toHaveBeenCalledWith("include tests");
		options.childRunRegistry!.dispose();
	});

	it("does not overwrite a closed run's persisted status when its turn settles late", async () => {
		const persisted: ChildRunRecord[] = [];
		const registry = new ChildRunRegistry();
		registry.setPersistence((record) => persisted.push(record));
		const child = fakeChild();
		let release!: (value: { output: string }) => void;
		child.handle.run = vi.fn(
			() =>
				new Promise<{ output: string }>((resolve) => {
					release = resolve;
				}),
		);
		const options = baseOptions({ childRunRegistry: registry, buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "task", { background: true });
		registry.close(started.handleId!);
		release({ output: "late output" });
		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toMatchObject({
			output: "late output",
			outcome: "completed",
		});

		const statuses = persisted.filter((record) => record.handleId === started.handleId).map((r) => r.status);
		expect(statuses[statuses.length - 1]).toBe("closed");
		registry.dispose();
	});
});

describe("child control boundary", () => {
	it("retains foreground children for follow-up and closes them exactly once", async () => {
		const child = fakeChild();
		child.handle.sendInput = vi.fn(async () => {});
		const options = baseOptions({ buildChildSession: async () => child.handle });
		await runDelegation(options, "scout", "task");
		const registry = options.childRunRegistry!;
		const [entry] = registry.list();
		expect(entry.agentType).toBe("scout");
		expect(child.dispose).not.toHaveBeenCalled();
		await registry.sendInput(entry.handleId, "continue");
		expect(child.handle.sendInput).toHaveBeenCalledWith("continue");
		await registry.wait(entry.handleId);
		registry.interrupt(entry.handleId);
		expect(child.handle.interrupt).toHaveBeenCalledOnce();
		registry.close(entry.handleId);
		registry.close(entry.handleId);
		expect(child.dispose).toHaveBeenCalledOnce();
		expect(registry.list()[0].status).toBe("closed");
		expect(() => registry.sendInput(entry.handleId, "no")).toThrow(/closed/i);
		await expect(registry.retrieve(entry.handleId)).resolves.toMatchObject({ output: "scout output" });
		registry.dispose();
		expect(child.dispose).toHaveBeenCalledOnce();
	});
});

describe("workspace release outcomes", () => {
	it("stores a kept outcome per session id and warns loudly without throwing", async () => {
		const registry = new ChildRunRegistry();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registry.setWorkspaceOwner({
			prepare: async (request) => request,
			release: async (sessionId) => ({ removed: false, kept: "dirty", dir: `/tmp/wt-${sessionId}` }),
		});
		try {
			registry.trackWorkspace("dirty-child");
			registry.dispose();
			// close() is synchronous and fire-and-forget: poll for the outcome.
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline && registry.workspaceReleaseOutcome("dirty-child") === undefined) {
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(registry.workspaceReleaseOutcome("dirty-child")).toEqual({
				removed: false,
				kept: "dirty",
				dir: "/tmp/wt-dirty-child",
			});
			const warned = warn.mock.calls.flat().join("\n");
			expect(warned).toContain("/tmp/wt-dirty-child");
			expect(warned).toMatch(/uncommitted child work preserved/i);
			expect(warned).toMatch(/git worktree remove --force/);
		} finally {
			warn.mockRestore();
			registry.dispose();
		}
	});

	it("stores a failed outcome with the owner's error and warns; owner throws are still swallowed", async () => {
		const registry = new ChildRunRegistry();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registry.setWorkspaceOwner({
			prepare: async (request) => request,
			release: async () => {
				throw new Error("git exploded");
			},
		});
		try {
			registry.trackWorkspace("boom-child");
			registry.dispose();
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline && registry.workspaceReleaseOutcome("boom-child") === undefined) {
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(registry.workspaceReleaseOutcome("boom-child")).toMatchObject({ removed: false, kept: "failed" });
			expect(warn.mock.calls.flat().join("\n")).toMatch(/git exploded/);
		} finally {
			warn.mockRestore();
			registry.dispose();
		}
	});

	it("reports removed outcomes and unknown ids", async () => {
		const registry = new ChildRunRegistry();
		registry.setWorkspaceOwner({
			prepare: async (request) => request,
			release: async () => ({ removed: true }),
		});
		registry.trackWorkspace("clean-child");
		registry.dispose();
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && registry.workspaceReleaseOutcome("clean-child") === undefined) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(registry.workspaceReleaseOutcome("clean-child")).toEqual({ removed: true });
		expect(registry.workspaceReleaseOutcome("never-tracked")).toBeUndefined();
		registry.dispose();
	});
});

describe("workspace launch reservations", () => {
	it("reserves ownership before asynchronous construction", async () => {
		let finish!: (child: ChildSessionHandle) => void;
		const child = fakeChild();
		const options = baseOptions({
			buildChildSession: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		const workspace = { isolation: "shared-read" as const, ownedPaths: ["/tmp/apex-reserved"] };
		const first = runDelegation(options, "scout", "first", { workspace });
		const second = runDelegation(options, "scout", "second", { workspace });
		await expect(second).rejects.toThrow(/overlaps/);
		finish(child.handle);
		await first;
		options.childRunRegistry!.dispose();
	});

	it("releases ownership after construction failure", async () => {
		const child = fakeChild();
		const build = vi.fn().mockRejectedValueOnce(new Error("construction failed")).mockResolvedValue(child.handle);
		const options = baseOptions({ buildChildSession: build });
		const workspace = { isolation: "shared-read" as const, ownedPaths: ["/tmp/apex-reserved"] };
		await expect(runDelegation(options, "scout", "first", { workspace })).rejects.toThrow(/construction failed/);
		await expect(runDelegation(options, "scout", "second", { workspace })).resolves.toMatchObject({
			output: "scout output",
		});
		options.childRunRegistry!.dispose();
	});
});

describe("child run concurrency admission (maxConcurrentChildren)", () => {
	it("admission refuses a child over maxConcurrentChildren and releases capacity on terminal settlement", async () => {
		const registry = new ChildRunRegistry();
		let releaseFirst!: () => void;
		const first = fakeChild("first output");
		first.handle.run = () =>
			new Promise<{ output: string }>((resolve) => {
				releaseFirst = () => resolve({ output: "first output" });
			});
		const buildChildSession = vi.fn(async () => first.handle);
		const options = baseOptions({ childRunRegistry: registry, maxConcurrentChildren: 1, buildChildSession });

		const started = await runDelegation(options, "scout", "first", { background: true });
		expect(started.handleId).toBeTruthy();

		// Over the limit: refused BEFORE any second child is built, naming the
		// limit and the way out.
		await expect(runDelegation(options, "scout", "second")).rejects.toThrow(/maxConcurrentChildren=1/);
		expect(buildChildSession).toHaveBeenCalledTimes(1);

		// Terminal settlement (completed) releases the slot...
		releaseFirst();
		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toMatchObject({
			output: "first output",
			outcome: "completed",
		});

		// ...so the next admission is admitted.
		const second = fakeChild("second output");
		buildChildSession.mockResolvedValue(second.handle);
		await expect(runDelegation(options, "scout", "third")).resolves.toMatchObject({ output: "second output" });
		registry.dispose();
	});

	it("admission releases capacity on delegation failure and on close", async () => {
		const registry = new ChildRunRegistry();
		let releaseRunning!: () => void;
		const failing = vi.fn().mockRejectedValueOnce(new Error("construction failed"));
		const options = baseOptions({ childRunRegistry: registry, maxConcurrentChildren: 1, buildChildSession: failing });

		// A failed launch never holds a slot: the very next admission is admitted.
		await expect(runDelegation(options, "scout", "first")).rejects.toThrow(/construction failed/);
		const running = fakeChild("running output");
		running.handle.run = () =>
			new Promise<{ output: string }>((resolve) => {
				releaseRunning = () => resolve({ output: "running output" });
			});
		failing.mockResolvedValue(running.handle);
		const started = await runDelegation(options, "scout", "second", { background: true });
		expect(started.handleId).toBeTruthy();

		// The active run holds the slot.
		await expect(runDelegation(options, "scout", "third")).rejects.toThrow(/maxConcurrentChildren=1/);

		// close() releases it even though the run never settled.
		registry.close(started.handleId!);
		const third = fakeChild("third output");
		failing.mockResolvedValue(third.handle);
		await expect(runDelegation(options, "scout", "fourth", { background: true })).resolves.toMatchObject({
			handleId: expect.any(String),
		});
		releaseRunning();
		registry.dispose();
	});

	it("historical resume counts against maxConcurrentChildren and releases on terminal settlement", async () => {
		const artifactDirA = mkdtempSync(join(tmpdir(), "apex-resume-slot-a-"));
		const artifactDirB = mkdtempSync(join(tmpdir(), "apex-resume-slot-b-"));
		try {
			writeFileSync(join(artifactDirA, "0000000000_hist-1.jsonl"), "{}\n", "utf-8");
			writeFileSync(join(artifactDirB, "0000000000_hist-2.jsonl"), "{}\n", "utf-8");
			const registry = new ChildRunRegistry();
			registry.restore([
				{
					handleId: "hist-1",
					agentType: "scout",
					sessionId: "hist-1",
					artifactDir: artifactDirA,
					status: "interrupted",
					updatedAt: Date.now(),
				},
				{
					handleId: "hist-2",
					agentType: "scout",
					sessionId: "hist-2",
					artifactDir: artifactDirB,
					status: "interrupted",
					updatedAt: Date.now(),
				},
			]);

			// The resumed turn hangs until the test releases it: the run stays
			// active and holds its slot.
			let releaseFirst!: () => void;
			const resumedA = fakeChild("resumed output");
			resumedA.handle.sendInput = () =>
				new Promise<void>((resolve) => {
					releaseFirst = () => {
						resumedA.setLatest({ outcome: "completed", output: "resumed output" });
						resolve();
					};
				});
			const resumedB = fakeChild("hist-2 output");
			const buildChildSession = vi.fn().mockResolvedValueOnce(resumedA.handle).mockResolvedValue(resumedB.handle);
			const options = baseOptions({
				childRunRegistry: registry,
				maxConcurrentChildren: 1,
				buildChildSession,
			});
			registry.setRuntimeOptions(options);

			const first = registry.resumeHistorical("hist-1");

			// While the resumed run is active, a second historical admission is
			// refused before any child is built, naming the limit.
			await expect(registry.resumeHistorical("hist-2")).rejects.toThrow(/maxConcurrentChildren=1/);
			expect(buildChildSession).toHaveBeenCalledTimes(1);

			// Terminal settlement releases the slot; the second record then resumes.
			releaseFirst();
			await expect(first).resolves.toBe("idle");
			await expect(registry.resumeHistorical("hist-2")).resolves.toBe("idle");
			expect(buildChildSession).toHaveBeenCalledTimes(2);
			registry.dispose();
		} finally {
			rmSync(artifactDirA, { recursive: true, force: true });
			rmSync(artifactDirB, { recursive: true, force: true });
		}
	});
});

describe("attempt records, idempotent spawn, timeouts, and status (phase 2)", () => {
	it("spawn with the same idempotency key returns the original handle without a second child", async () => {
		const persisted: ChildRunRecord[] = [];
		const registry = new ChildRunRegistry();
		registry.setPersistence((record) => persisted.push(record));
		const child = deferredChild();
		const buildChildSession = vi.fn(async () => child.handle);
		const options = baseOptions({ childRunRegistry: registry, maxConcurrentChildren: 1, buildChildSession });

		const first = await runDelegation(options, "scout", "recon the config loader", {
			background: true,
			idempotencyKey: "recon-key",
		});
		// The duplicate must return the EXISTING handle: with maxConcurrentChildren
		// held at 1 by the first run, a second admission would throw -- resolving
		// proves no second slot was consumed.
		const second = await runDelegation(options, "scout", "recon the config loader", {
			background: true,
			idempotencyKey: "recon-key",
		});
		expect(second.handleId).toBe(first.handleId);
		expect(buildChildSession).toHaveBeenCalledTimes(1);
		// A different key is a different run: settle the first child so its slot
		// is released, then spawn under a new key.
		child.settle();
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 0));
		const other = deferredChild();
		buildChildSession.mockResolvedValue(other.handle);
		const third = await runDelegation(options, "scout", "other task", {
			background: true,
			idempotencyKey: "other-key",
		});
		expect(third.handleId).not.toBe(first.handleId);
		// A restarted parent rebuilds the key->handle map from the persisted
		// records and dedupes too, without building a child.
		const restarted = new ChildRunRegistry();
		const restartedBuild = vi.fn(async () => deferredChild().handle);
		const restartedOptions = baseOptions({
			childRunRegistry: restarted,
			maxConcurrentChildren: 1,
			buildChildSession: restartedBuild,
		});
		restarted.restore(persisted);
		const fourth = await runDelegation(restartedOptions, "scout", "recon the config loader", {
			background: true,
			idempotencyKey: "recon-key",
		});
		expect(fourth.handleId).toBe(first.handleId);
		expect(restartedBuild).not.toHaveBeenCalled();
		restarted.dispose();
		registry.dispose();
	});

	it("legacy records without attempts load with one synthesized attempt", () => {
		const registry = new ChildRunRegistry();
		registry.restore([
			{ handleId: "legacy-run", agentType: "scout", status: "interrupted", updatedAt: 123 },
			{ handleId: "legacy-open", agentType: "scout", status: "running", updatedAt: 456 },
		]);
		const interrupted = registry.status("legacy-run");
		expect(interrupted.handleId).toBe("legacy-run");
		expect(interrupted.attempts).toBe(1);
		expect(interrupted.attempt.id).toBeTruthy();
		expect(interrupted.attempt.outcome).toBe("interrupted");
		const running = registry.status("legacy-open");
		expect(running.attempts).toBe(1);
		// Stale-running reconciliation: a persisted running record cannot be live
		// in this fresh process, so restore interrupts it and closes its
		// synthesized attempt as interrupted (see the dedicated reconciliation test
		// below).
		expect(running.status).toBe("interrupted");
		expect(running.attempt.outcome).toBe("interrupted");
		// The list payload carries the same count without dropping old fields.
		const listed = registry.list().find((run) => run.handleId === "legacy-run");
		expect(listed).toMatchObject({ handleId: "legacy-run", agentType: "scout", status: "interrupted" });
		expect(listed!.attemptCount).toBe(1);
		registry.dispose();
	});

	it("resume opens a new attempt and closes the prior one", async () => {
		const artifactDir = mkdtempSync(join(tmpdir(), "apex-resume-attempt-"));
		try {
			writeFileSync(join(artifactDir, "0000000000_hist-attempt.jsonl"), "{}\n", "utf-8");
			const persisted: ChildRunRecord[] = [];
			const registry = new ChildRunRegistry();
			registry.setPersistence((record) => persisted.push(record));
			// A legacy (attempt-less) interrupted record: resume must close its
			// synthesized attempt with the record's terminal outcome and open a new one.
			registry.restore([
				{
					handleId: "hist-attempt",
					agentType: "scout",
					sessionId: "hist-attempt",
					artifactDir,
					task: "earlier recon",
					status: "interrupted",
					updatedAt: 123,
				},
			]);
			const resumed = fakeChild("resumed recon output");
			const options = baseOptions({
				childRunRegistry: registry,
				buildChildSession: vi.fn(async () => resumed.handle),
			});
			registry.setRuntimeOptions(options);

			await expect(registry.resumeHistorical("hist-attempt")).resolves.toBe("idle");

			const last = persisted[persisted.length - 1];
			expect(last.attempts).toHaveLength(2);
			expect(last.attempts![0]!.outcome).toBe("interrupted");
			expect(typeof last.attempts![0]!.endedAt).toBe("number");
			expect(last.attempts![1]!.outcome).toBe("completed");
			expect(last.activeAttemptId).toBe(last.attempts![1]!.id);
			// The status payload reflects the new active attempt.
			const status = registry.status("hist-attempt");
			expect(status.attempts).toBe(2);
			expect(status.attempt.id).toBe(last.attempts![1]!.id);
			registry.dispose();
		} finally {
			rmSync(artifactDir, { recursive: true, force: true });
		}
	});

	it("interrupt with a reason records cancelled on the record and attempt", async () => {
		const persisted: ChildRunRecord[] = [];
		const registry = new ChildRunRegistry();
		registry.setPersistence((record) => persisted.push(record));
		const child = deferredChild();
		const options = baseOptions({ childRunRegistry: registry, buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "long task", { background: true });

		registry.interrupt(started.handleId!, "user requested stop");

		const last = persisted[persisted.length - 1];
		expect(last.cancelled).toMatchObject({ reason: "user requested stop" });
		expect(typeof last.cancelled!.at).toBe("number");
		expect(last.attempts![0]!.outcome).toBe("cancelled");
		const status = registry.status(started.handleId!);
		expect(status.cancelled).toMatchObject({ reason: "user requested stop" });
		expect(status.attempt.outcome).toBe("cancelled");
		registry.dispose();
	});

	it("status reports a timed-out running child and interrupts it", async () => {
		const registry = new ChildRunRegistry();
		const child = deferredChild();
		const options = baseOptions({ childRunRegistry: registry, buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "long task", { background: true, timeoutMs: 0 });
		expect(child.handle.status).toBe("running");

		// The deadline (launch + timeoutMs = now) is already due: the status
		// observation interrupts the running child lazily and reports it.
		const status = registry.status(started.handleId!);
		expect(typeof status.deadlineMs).toBe("number");
		expect(status.deadlineMs!).toBeLessThanOrEqual(Date.now());
		expect(status.status).toBe("interrupted");
		expect(child.handle.interrupt).toHaveBeenCalledTimes(1);
		registry.dispose();
	});
});

describe("workspace states and explicit recovery (phase 3)", () => {
	it("restored running records become interrupted with an interrupted attempt", () => {
		const registry = new ChildRunRegistry();
		const persist = vi.fn();
		registry.setPersistence(persist);
		registry.restore([
			{
				handleId: "stale-run",
				agentType: "scout",
				sessionId: "stale-run",
				status: "running",
				updatedAt: 456,
				attempts: [{ id: "attempt-1", startedAt: 400 }],
				activeAttemptId: "attempt-1",
			},
		]);

		// Reconciliation is in-memory only: the historical JSONL is never
		// rewritten by restore; the corrected status persists with the record's
		// next save.
		expect(persist).not.toHaveBeenCalled();

		const status = registry.status("stale-run");
		expect(status.status).toBe("interrupted");
		expect(status.attempt).toMatchObject({ id: "attempt-1", outcome: "interrupted" });
		const listed = registry.list().find((run) => run.handleId === "stale-run");
		expect(listed).toMatchObject({ handleId: "stale-run", status: "interrupted" });
		registry.dispose();
	});

	it("release outcomes persist workspaceState on the record", async () => {
		const persisted: ChildRunRecord[] = [];
		const registry = new ChildRunRegistry();
		registry.setPersistence((record) => persisted.push(record));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const child = deferredChild();
		const options = baseOptions({
			childRunRegistry: registry,
			buildChildSession: async () => child.handle,
			workspaceOwner: {
				prepare: async (request) => ({ ...request, root: `/tmp/wt-${request.sessionId}` }),
				release: async (sessionId) =>
					sessionId === "released-child"
						? { removed: true as const }
						: ({ removed: false as const, kept: "dirty" as const, dir: `/tmp/wt-${sessionId}` } as const),
			},
		});
		try {
			await runDelegation(options, "scout", "task one", {
				background: true,
				handleId: "released-child",
				workspace: { isolation: "worktree", ownedPaths: [] },
			});
			await runDelegation(options, "scout", "task two", {
				background: true,
				handleId: "kept-child",
				workspace: { isolation: "worktree", ownedPaths: [] },
			});

			// Closing each run releases its tracked workspace through the owner; the
			// outcomes classify the records and persist.
			registry.close("released-child");
			registry.close("kept-child");
			registry.dispose();
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline && persisted.filter((record) => record.workspaceState !== undefined).length < 2) {
				await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
			}

			const released = persisted.filter((record) => record.handleId === "released-child").at(-1);
			expect(released).toMatchObject({
				handleId: "released-child",
				status: "closed",
				workspace: { isolation: "worktree" },
				workspaceState: "released",
			});
			const kept = persisted.filter((record) => record.handleId === "kept-child").at(-1);
			expect(kept).toMatchObject({
				handleId: "kept-child",
				workspace: { isolation: "worktree" },
				workspaceState: "retained-dirty",
			});
		} finally {
			warn.mockRestore();
			registry.dispose();
		}
	});

	it("recoverWorkspace verifies the admin entry and branch before reactivating", async () => {
		function git(cwd: string, ...args: string[]): string {
			const result = spawnSync("git", args, { cwd, encoding: "utf8" });
			if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
			return result.stdout.trim();
		}

		const repo = mkdtempSync(join(tmpdir(), "apex-recover-repo-"));
		try {
			writeFileSync(join(repo, ".gitignore"), ".apex-code/worktrees/\n", "utf-8");
			git(repo, "init", "-b", "main");
			git(repo, "config", "user.email", "recover-test@example.com");
			git(repo, "config", "user.name", "recover-test");
			git(repo, "add", "-A");
			git(repo, "commit", "-m", "init");

			const owner = new GitWorktreeWorkspaceOwner(repo);
			const handleId = "rec-child"; // branch: apex-child-rec-chil (first 8 chars)
			const prepared = await owner.prepare({ isolation: "worktree", ownedPaths: [], sessionId: handleId });
			const root = prepared.root;
			expect(existsSync(root)).toBe(true);

			const persisted: ChildRunRecord[] = [];
			const registry = new ChildRunRegistry();
			registry.setPersistence((record) => persisted.push(record));
			registry.restore([
				{
					handleId,
					agentType: "scout",
					sessionId: handleId,
					status: "completed",
					updatedAt: 123,
					workspace: { isolation: "worktree", ownedPaths: [], root },
					workspaceState: "retained-dirty",
				},
			]);
			registry.setWorkspaceOwner(owner);

			// Tampered branch (detached HEAD): the refusal names the failed check,
			// and nothing is verified, persisted, or changed.
			git(root, "checkout", "--detach", "HEAD");
			await expect(registry.recoverWorkspace(handleId)).rejects.toThrow(/branch check failed/);
			await expect(registry.recoverWorkspace(handleId)).rejects.toThrow(/unverified/);
			expect(persisted).toHaveLength(0);

			// Tampered admin entry (gitdir pointing outside the repository): the
			// refusal names the admin-entry check.
			const adminEntry = readFileSync(join(root, ".git"), "utf-8");
			writeFileSync(join(root, ".git"), "gitdir: /nowhere/apex-other-worktree\n", "utf-8");
			await expect(registry.recoverWorkspace(handleId)).rejects.toThrow(/admin entry check failed/);
			writeFileSync(join(root, ".git"), adminEntry, "utf-8");

			// Clean case: recovery verifies the worktree and reactivates it.
			git(root, "checkout", "apex-child-rec-chil");
			await expect(registry.recoverWorkspace(handleId)).resolves.toEqual({
				workspaceState: "active",
				dirty: false,
			});
			const stamped = persisted.at(-1);
			expect(stamped).toMatchObject({ handleId, workspaceState: "active" });

			// Uncommitted work is reported, not destroyed: dirty comes from the
			// real worktree status.
			writeFileSync(join(root, "uncommitted.txt"), "child work", "utf-8");
			await expect(registry.recoverWorkspace(handleId)).resolves.toEqual({
				workspaceState: "active",
				dirty: true,
			});
			expect(existsSync(join(root, "uncommitted.txt"))).toBe(true);
			registry.dispose();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("child usage and cost accounting (phase 5)", () => {
	it("attempt snapshots carry cumulative token totals at settlement", async () => {
		const parentDir = mkdtempSync(join(tmpdir(), "apex-usage-attempt-"));
		try {
			const persisted: ChildRunRecord[] = [];
			const registry = new ChildRunRegistry();
			registry.setPersistence((record) => persisted.push(record));
			const child = fakeChild("scout usage output");
			let transcriptFile: string | undefined;
			const buildChildSession = vi.fn(async (request: BuildChildSessionRequest) => {
				if (!request.artifactDir) throw new Error("expected an artifact dir");
				transcriptFile = writeUsageTranscript(request.artifactDir, request.sessionId);
				return child.handle;
			});
			// A follow-up turn appends one more usage-bearing entry to the SAME
			// transcript, so the next settlement's snapshot must be cumulative.
			child.handle.sendInput = async () => {
				if (!transcriptFile) throw new Error("expected a transcript file");
				SessionManager.open(transcriptFile).appendMessage(usageAssistantMessage("scout turn three", USAGE_B));
				child.setLatest({ outcome: "completed", output: "follow-up output" });
			};
			const options = baseOptions({
				childRunRegistry: registry,
				getParentSessionDir: () => parentDir,
				buildChildSession,
			});
			const started = await runDelegation(options, "scout", "recon the config loader", {
				background: true,
				handleId: "usage-attempt-child",
			});
			await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toMatchObject({
				output: "scout usage output",
				outcome: "completed",
			});

			// The settled attempt carries the cumulative-at-end snapshot (these are
			// cumulative-at-end rollups of the child transcript, not per-attempt
			// deltas).
			const attempt = persisted.at(-1)!.attempts![0]!;
			expect(attempt.id).toBe("attempt-1");
			expect(attempt.tokensAtEnd).toMatchObject({ ...USAGE_SUM_AB, entriesCounted: 2 });
			expect(typeof attempt.tokensAtEnd!.asOf).toBe("number");

			// The follow-up stays inside the SAME attempt (follow-ups never open a
			// new epoch), so its settlement re-stamps a larger cumulative snapshot.
			await registry.sendInput(started.handleId!, "go deeper");
			const attemptAfterFollowUp = persisted.at(-1)!.attempts![0]!;
			expect(attemptAfterFollowUp.id).toBe("attempt-1");
			expect(attemptAfterFollowUp.tokensAtEnd).toMatchObject({
				inputTokens: 160,
				outputTokens: 18,
				cacheReadTokens: 9,
				cacheWriteTokens: 9,
				totalTokens: 196,
				entriesCounted: 3,
			});
			expect(attemptAfterFollowUp.tokensAtEnd!.cost).toEqual({
				input: 1,
				output: 0.5,
				cacheRead: 0.25,
				cacheWrite: 0.125,
				total: 1.875,
			});

			// The pollable status carries the same rollup, flattened, for the live
			// run, and usageTotals() exposes the full totals record.
			const status = registry.status(started.handleId!);
			expect(status.tokens).toEqual({
				inputTokens: 160,
				outputTokens: 18,
				cacheReadTokens: 9,
				cacheWriteTokens: 9,
				totalTokens: 196,
			});
			expect(status.cost).toEqual({ input: 1, output: 0.5, cacheRead: 0.25, cacheWrite: 0.125, total: 1.875 });
			expect(registry.usageTotals(started.handleId!)).toMatchObject({
				inputTokens: 160,
				outputTokens: 18,
				cacheReadTokens: 9,
				cacheWriteTokens: 9,
				totalTokens: 196,
				entriesCounted: 3,
			});
			registry.dispose();
		} finally {
			rmSync(parentDir, { recursive: true, force: true });
		}
	});

	it("in-memory child without reachable transcript omits tokens in status", async () => {
		const registry = new ChildRunRegistry();
		const child = fakeChild("in-memory output");
		// No getParentSessionDir: the child is never file-backed, and the stub
		// handle exposes no session-entry seam, so no rollup is reachable.
		const options = baseOptions({ childRunRegistry: registry, buildChildSession: async () => child.handle });
		const started = await runDelegation(options, "scout", "task", { background: true });
		await expect(retrieveDelegationResult(options, started.handleId!, "scout")).resolves.toMatchObject({
			output: "in-memory output",
			outcome: "completed",
		});

		const status = registry.status(started.handleId!);
		expect(status.tokens).toBeUndefined();
		expect(status.cost).toBeUndefined();
		expect(registry.usageTotals(started.handleId!)).toBeUndefined();
		// Reporting the absence never throws.
		expect(() => registry.status(started.handleId!)).not.toThrow();
		registry.dispose();
	});
});
