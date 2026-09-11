import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { access, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	AgentDefinition,
	ChildRunRecord,
	ChildSessionHandle,
	ChildWorkspaceRequest,
	DelegationRuntimeOptions,
} from "../../src/core/delegation/runtime.ts";
import { ChildRunRegistry, runDelegation } from "../../src/core/delegation/runtime.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import {
	createAgentSession,
	SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE,
	SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE,
} from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DEFAULT_MAX_TOOL_CALLS, type ResolvedRunBudget, SettingsManager } from "../../src/core/settings-manager.ts";
import type { Capability } from "../../src/core/tools/contract.ts";
import { GitWorktreeWorkspaceOwner } from "../../src/core/workspace/git-worktree-owner.ts";
import { scratchDir } from "../suite/scratch.ts";

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

let scratch: string;
let previousCwd: string;

beforeEach(async () => {
	scratch = await scratchDir("apex-delegation-e2e-");
	previousCwd = process.cwd();
	process.chdir(scratch);
});

afterEach(async () => {
	process.chdir(previousCwd);
	await rm(scratch, { recursive: true, force: true });
});

const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
	scout: { name: "scout", description: "Fast recon", tools: ["read"], systemPrompt: "You are a scout." },
	worker: {
		name: "worker",
		description: "General purpose",
		tools: ["read", "bash"],
		systemPrompt: "You are a worker.",
	},
	writer: {
		name: "writer",
		description: "Writes workspace files",
		tools: ["read", "write"],
		systemPrompt: "You are a writer.",
	},
};

async function buildModelRuntime(providerId: string) {
	const faux = fauxProvider({ provider: providerId });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [providerId] });
	return { faux, runtime };
}

async function buildParentSession(
	providerId: string,
	options: {
		/** Written to `<agentDir>/settings.json` before the manager reads it. */
		settings?: Record<string, unknown>;
		/** Observe the settings manager before any session consumes it (e.g. to spy on getRunBudget). */
		createdSettingsManager?: (settingsManager: SettingsManager) => void;
		runBudget?: ResolvedRunBudget;
		/** Explicit root aggregate budget (spec 2026-09-09, "Shared budgets"). */
		aggregateBudget?: ResolvedRunBudget;
		/** Agent definitions the parent's delegation resolver serves. Default: AGENT_DEFINITIONS. */
		agentDefinitions?: Record<string, AgentDefinition>;
		/** Parent's active tools. Default: read + delegate. */
		tools?: string[];
		/** Extra local permission rules granted beside the `delegate` allow. */
		rules?: Array<{ toolName: string; behavior: "allow" | "deny" | "ask"; ruleContent?: string }>;
		/** Injected child-run registry (for tests that seed historical records). */
		childRunRegistry?: ChildRunRegistry;
		/** Injected session manager (for tests that reopen an existing session file). */
		sessionManager?: SessionManager;
	} = {},
) {
	const { faux, runtime } = await buildModelRuntime(providerId);
	if (options.settings !== undefined) {
		mkdirSync(join(scratch, "agent"), { recursive: true });
		writeFileSync(join(scratch, "agent", "settings.json"), JSON.stringify(options.settings), "utf-8");
	}
	const settingsManager = SettingsManager.create(scratch, join(scratch, "agent"));
	options.createdSettingsManager?.(settingsManager);
	const store = new FilePermissionRuleStore({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		policyPath: join(scratch, "missing-policy.json"),
	});
	await store.apply({
		type: "addRules",
		destination: "local",
		rules: [{ toolName: "delegate", behavior: "allow" }, ...(options.rules ?? [])],
	});

	const created = await createAgentSession({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager,
		tools: options.tools ?? ["read", "delegate"],
		permissionGate: { store, getMode: () => "default" },
		delegation: { resolveAgent: (agentType) => (options.agentDefinitions ?? AGENT_DEFINITIONS)[agentType] },
		runBudget: options.runBudget,
		aggregateBudget: options.aggregateBudget,
		childRunRegistry: options.childRunRegistry,
		sessionManager: options.sessionManager,
	});
	await created.session.bindExtensions({});
	return { session: created.session, faux, delegationRuntime: created.delegationRuntime };
}

describe("delegation end-to-end through createAgentSession (task 5.2)", () => {
	it("delegates to a real child session and returns the child's real output to the parent", async () => {
		const { session, faux } = await buildParentSession("delegation-e2e-1");
		const delegateCall = fauxToolCall("delegate", { agentType: "scout", task: "find the config loader" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("scout found it in config.ts", { stopReason: "stop" }), // the child's own turn
			fauxAssistantMessage("Delegation complete.", { stopReason: "stop" }), // the parent's turn after the tool result
		]);

		await session.prompt("delegate to scout");

		const toolResult = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === delegateCall.id,
		);
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result message");
		expect(toolResult.isError).toBe(false);
		const text = toolResult.content.find((c) => c.type === "text")?.text;
		expect(text).toContain("scout found it in config.ts");

		const [child] = session.listChildRuns();
		expect(child.status).toBe("idle");
		await expect(session.waitChildRun(child.handleId)).resolves.toMatchObject({
			output: "scout found it in config.ts",
			outcome: "completed",
		});
		faux.setResponses([fauxAssistantMessage("follow-up complete", { stopReason: "stop" })]);
		await session.sendChildInput(child.handleId, "continue investigating");
		expect(session.listChildRuns()[0].status).toBe("idle");
		await expect(session.waitChildRun(child.handleId)).resolves.toMatchObject({
			output: "follow-up complete",
			outcome: "completed",
		});

		session.dispose();
	});

	it("stores a real child's session only under its per-child artifact directory while a permitted workspace write succeeds", async () => {
		const { faux, runtime } = await buildModelRuntime("delegation-artifacts-e2e");
		const agentDir = join(scratch, "agent");
		const settingsManager = SettingsManager.create(scratch, agentDir);
		const store = new FilePermissionRuleStore({
			cwd: scratch,
			agentDir,
			policyPath: join(scratch, "missing-policy.json"),
		});
		await store.apply({
			type: "addRules",
			destination: "local",
			rules: [
				{ toolName: "delegate", behavior: "allow" },
				{ toolName: "write", behavior: "allow", ruleContent: "child-output.txt" },
			],
		});
		const { session } = await createAgentSession({
			cwd: scratch,
			agentDir,
			model: faux.getModel(),
			modelRuntime: runtime,
			settingsManager,
			tools: ["read", "write", "delegate"],
			permissionGate: { store, getMode: () => "default" },
			delegation: {
				resolveAgent: (agentType) =>
					agentType === "writer"
						? {
								name: "writer",
								description: "writes workspace output",
								tools: ["write"],
								systemPrompt: "Write the requested file.",
							}
						: undefined,
			},
		});
		await session.bindExtensions({});
		const delegateCall = fauxToolCall("delegate", { agentType: "writer", task: "write child-output.txt" });
		const writeCall = fauxToolCall("write", { path: "child-output.txt", content: "workspace edit" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage([writeCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("child wrote the workspace file", { stopReason: "stop" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		await session.prompt("delegate to writer");
		expect(await readFile(join(scratch, "child-output.txt"), "utf8")).toBe("workspace edit");
		const result = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === delegateCall.id,
		);
		if (result?.role !== "toolResult") throw new Error("expected a delegation result");
		expect(result.isError).toBe(false);
		const childJsonl = await (async () => {
			const { readdir } = await import("node:fs/promises");
			const roots = await readdir(join(session.sessionManager.getSessionDir(), "delegations"));
			expect(roots).toHaveLength(1);
			return join(
				session.sessionManager.getSessionDir(),
				"delegations",
				roots[0]!,
				(await readdir(join(session.sessionManager.getSessionDir(), "delegations", roots[0]!))).find((f) =>
					f.endsWith(".jsonl"),
				)!,
			);
		})();
		await access(childJsonl);
		expect(childJsonl).toContain(join(session.sessionManager.getSessionDir(), "delegations"));
		// Evidence linkage model (plan 2026-09-09, evidence rows): the per-child
		// session file under the parent's delegations/ dir IS the run linkage.
		// The directory and file name carry the handle `delegate` returns, and the
		// child header names the parent session, so any workflow evidence record's
		// `handle` resolves to exactly this session file.
		const [childRun] = session.listChildRuns();
		expect(basename(childJsonl)).toMatch(new RegExp(`_${childRun.handleId}\\.jsonl$`));
		const header = JSON.parse((await readFile(childJsonl, "utf8")).split("\n", 1)[0]!) as {
			id?: string;
			parentSession?: string;
		};
		expect(header.id).toBe(childRun.handleId);
		expect(header.parentSession).toBe(session.sessionManager.getSessionId());
		session.dispose();
	});

	it("refuses delegation whose requested tools exceed the parent's capabilities -- never yields a child holding bash", async () => {
		const { session, faux } = await buildParentSession("delegation-e2e-2");
		const delegateCall = fauxToolCall("delegate", { agentType: "worker", task: "run the test suite" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("Noted the refusal.", { stopReason: "stop" }),
		]);

		// The parent's active tools are only read + delegate -- no exec anywhere,
		// so "worker" (which needs bash => exec) must be refused before any child exists.
		await session.prompt("delegate to worker");

		const toolResult = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === delegateCall.id,
		);
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result message");
		expect(toolResult.isError).toBe(true);
		const text = toolResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/exec/i);

		session.dispose();
	});
});

describe("delegation recursion depth guard through createAgentSession (task 5.3)", () => {
	it("admits delegation up to the default bound (2) and refuses a third level, naming the bound", async () => {
		// A self-delegating agent, so depth actually gets exercised: root (depth 0)
		// -> child (depth 1) -> grandchild (depth 2), where the grandchild's own
		// attempt to delegate again is refused by the depth guard before any
		// great-grandchild session is built.
		const recursiveDefinitions: Record<string, AgentDefinition> = {
			scout: {
				name: "scout",
				description: "recon, can delegate further",
				tools: ["read", "delegate"],
				systemPrompt: "You are a scout.",
			},
		};
		const { faux, runtime } = await buildModelRuntime("delegation-depth-e2e");
		const settingsManager = SettingsManager.create(scratch, join(scratch, "agent"));
		const store = new FilePermissionRuleStore({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			policyPath: join(scratch, "missing-policy.json"),
		});
		await store.apply({
			type: "addRules",
			destination: "local",
			rules: [{ toolName: "delegate", behavior: "allow" }],
		});

		const { session } = await createAgentSession({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			model: faux.getModel(),
			modelRuntime: runtime,
			settingsManager,
			tools: ["read", "delegate"],
			permissionGate: { store, getMode: () => "default" },
			delegation: { resolveAgent: (agentType) => recursiveDefinitions[agentType] },
		});
		await session.bindExtensions({});

		const rootCall = fauxToolCall("delegate", { agentType: "scout", task: "T1" });
		const childCall = fauxToolCall("delegate", { agentType: "scout", task: "T2" });
		const grandchildCall = fauxToolCall("delegate", { agentType: "scout", task: "T3" });
		faux.setResponses([
			fauxAssistantMessage([rootCall], { stopReason: "toolUse" }), // root, depth 0: delegates
			fauxAssistantMessage([childCall], { stopReason: "toolUse" }), // child, depth 1: delegates
			fauxAssistantMessage([grandchildCall], { stopReason: "toolUse" }), // grandchild, depth 2: tries to delegate again -- refused
			fauxAssistantMessage("grandchild done", { stopReason: "stop" }), // grandchild's final turn, after the depth refusal
			fauxAssistantMessage("child done", { stopReason: "stop" }), // child's final turn
			fauxAssistantMessage("root done", { stopReason: "stop" }), // root's final turn
		]);

		await session.prompt("go");

		// The precise signal: exactly 6 model turns fired (root x2, child x2,
		// grandchild x2). If the depth guard failed to block the grandchild's
		// third-level delegate call, a real great-grandchild session would need at
		// least one more turn -- the faux provider's response queue is shift()-based,
		// not cycling, so an extra call would consume a response meant for a
		// different level and cascade into either an off-by-one output or an
		// exhausted-queue error. This assertion catches that directly rather than
		// inferring it from shifted text.
		expect(faux.state.callCount).toBe(6);

		const rootResult = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === rootCall.id,
		);
		if (rootResult?.role !== "toolResult") throw new Error("expected root's tool result");
		expect(rootResult.isError).toBe(false);
		const rootText = rootResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(rootText).toContain("child done");

		session.dispose();
	});
});

describe("child budget and verification wiring (spec 2026-09-09)", () => {
	/** A real verification policy whose subprocess exits with `exitCode`. Cheap and observable. */
	function verificationPolicy(id: string, exitCode: number): Record<string, unknown> {
		return {
			id,
			executable: process.execPath,
			argv: ["-e", `process.exit(${exitCode})`],
			permission: "allow",
			blocksCompletion: true,
		};
	}

	function delegateToolResult(session: Awaited<ReturnType<typeof buildParentSession>>["session"], callId: string) {
		const toolResult = session.agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === callId);
		if (toolResult?.role !== "toolResult") throw new Error("expected a delegation tool result");
		return toolResult;
	}

	async function runScoutDelegation(
		session: Awaited<ReturnType<typeof buildParentSession>>["session"],
		faux: Awaited<ReturnType<typeof buildParentSession>>["faux"],
	) {
		const delegateCall = fauxToolCall("delegate", { agentType: "scout", task: "recon the config loader" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("scout recon done", { stopReason: "stop" }), // the child's own turn
			fauxAssistantMessage("parent noted the delegation", { stopReason: "stop" }),
		]);
		await session.prompt("delegate to scout");
		return delegateCall;
	}

	it("carries the createAgentSession runBudget override into the Agent and forwards it to child sessions", async () => {
		const budget: ResolvedRunBudget = { maxProviderRequests: 7, maxToolCalls: 11, maxWallTimeMs: 654321 };
		let getRunBudgetCalls = 0;
		const { session, faux } = await buildParentSession("budget-override-e2e", {
			// Settings name a DIFFERENT policy. The override must win and the
			// settings read must never happen -- not for the parent and not for a
			// child built during delegation (the child inherits the parent's
			// resolved budget instead of re-reading settings).
			settings: { runBudget: { maxProviderRequests: 99, maxToolCalls: 999 } },
			createdSettingsManager: (manager) => {
				vi.spyOn(manager, "getRunBudget").mockImplementation(() => {
					getRunBudgetCalls++;
					return { maxProviderRequests: 99, maxToolCalls: 999, maxWallTimeMs: undefined };
				});
			},
			runBudget: budget,
		});
		expect(session.agent.runBudget).toBe(budget);

		const delegateCall = await runScoutDelegation(session, faux);
		const toolResult = delegateToolResult(session, delegateCall.id);
		expect(toolResult.isError).toBe(false);
		// Both the parent's Agent and the child's Agent got the same resolved
		// policy without a single settings read.
		expect(getRunBudgetCalls).toBe(0);

		const [child] = session.listChildRuns();
		await expect(session.waitChildRun(child.handleId)).resolves.toMatchObject({
			output: "scout recon done",
			outcome: "completed",
		});
		session.dispose();
	});

	it("defaults each session's Agent to the settings-resolved run budget, read once per session", async () => {
		let getRunBudgetCalls = 0;
		const { session, faux } = await buildParentSession("budget-default-e2e", {
			settings: { runBudget: { maxProviderRequests: 50 } },
			createdSettingsManager: (manager) => {
				vi.spyOn(manager, "getRunBudget").mockImplementation(() => {
					getRunBudgetCalls++;
					return { maxProviderRequests: 50, maxToolCalls: DEFAULT_MAX_TOOL_CALLS, maxWallTimeMs: undefined };
				});
			},
		});
		expect(session.agent.runBudget).toEqual({
			maxProviderRequests: 50,
			maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
			maxWallTimeMs: undefined,
		});

		const delegateCall = await runScoutDelegation(session, faux);
		const toolResult = delegateToolResult(session, delegateCall.id);
		expect(toolResult.isError).toBe(false);
		// Exactly one read, by the parent: the child inherits the parent's
		// already-resolved budget through buildChildSession instead of resolving
		// its own second classification. Per-run only -- each session counts its
		// own runs against this policy; no aggregate counter spans the two.
		expect(getRunBudgetCalls).toBe(1);

		const [child] = session.listChildRuns();
		await expect(session.waitChildRun(child.handleId)).resolves.toMatchObject({
			output: "scout recon done",
			outcome: "completed",
		});
		session.dispose();
	});

	it("timeoutMs bounds a child run at the wall-time gate", async () => {
		const { session, faux, delegationRuntime } = await buildParentSession("timeout-wall-time-e2e", {
			runBudget: { maxProviderRequests: 5 },
		});
		const handleId = "timeout-child";
		// timeoutMs 0 drives the child's OWN wall-time gate without any real wait:
		// the child budget policy is built with maxWallTimeMs=0, so the very first
		// provider request is refused mid-run by the existing budget gate and the
		// queued faux response is never consumed.
		faux.setResponses([fauxAssistantMessage("never consumed", { stopReason: "stop" })]);
		await runDelegation(delegationRuntime!, "scout", "recon the config loader", {
			background: true,
			handleId,
			timeoutMs: 0,
		});
		await expect(session.waitChildRun(handleId)).rejects.toThrow(/wall-time/);
		expect(faux.state.callCount).toBe(0);

		// The launch recorded the wall-clock deadline, and the failed settlement
		// is readable from the pollable status without awaiting anything.
		const status = session.childRunStatus(handleId);
		expect(typeof status.deadlineMs).toBe("number");
		expect(status.deadlineMs!).toBeLessThanOrEqual(Date.now());
		expect(status.attempt.outcome).toBe("failed");
		expect(status.lastResult?.outcome).toBe("failed");
		session.dispose();
	});

	it("fails a child turn whose configured verification policy fails, naming the status", async () => {
		const { session, faux } = await buildParentSession("child-verification-fail-e2e", {
			settings: {
				policies: { schemaVersion: 1, verification: [verificationPolicy("child-check", 1)] },
			},
		});

		const delegateCall = await runScoutDelegation(session, faux);
		const toolResult = delegateToolResult(session, delegateCall.id);
		expect(toolResult.isError).toBe(true);
		const text = toolResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/verification failed: failed/i);
		expect(text).toContain("child-check");

		// The registry's settlement records the failure: retrieval re-raises the
		// verification error instead of serving a completed result.
		const [child] = session.listChildRuns();
		await expect(session.waitChildRun(child.handleId)).rejects.toThrow(/verification failed: failed/i);
		session.dispose();
	});

	it("completes a child turn whose configured verification policy passes, and the policy really ran", async () => {
		const { session, faux } = await buildParentSession("child-verification-pass-e2e", {
			settings: {
				policies: {
					schemaVersion: 1,
					verification: [
						{
							id: "child-check",
							executable: process.execPath,
							argv: ["-e", `require("fs").writeFileSync("verification-ran.txt", "ran", "utf8")`],
							permission: "allow",
							blocksCompletion: true,
						},
					],
				},
			},
		});

		const delegateCall = await runScoutDelegation(session, faux);
		const toolResult = delegateToolResult(session, delegateCall.id);
		expect(toolResult.isError).toBe(false);
		const text = toolResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("scout recon done");

		const [child] = session.listChildRuns();
		await expect(session.waitChildRun(child.handleId)).resolves.toMatchObject({
			output: "scout recon done",
			outcome: "completed",
		});
		// The completion gate executed the configured policy inside the child.
		await access(join(scratch, "verification-ran.txt"));
		session.dispose();
	});

	it("leaves children unchanged when no verification policies are configured", async () => {
		const { session, faux } = await buildParentSession("child-no-policies-e2e", { settings: {} });

		const delegateCall = await runScoutDelegation(session, faux);
		const toolResult = delegateToolResult(session, delegateCall.id);
		expect(toolResult.isError).toBe(false);
		const text = toolResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toContain("scout recon done");

		const [child] = session.listChildRuns();
		await expect(session.waitChildRun(child.handleId)).resolves.toMatchObject({
			output: "scout recon done",
			outcome: "completed",
		});
		session.dispose();
	});
});

describe("shared family budget across child sessions (spec 2026-09-09)", () => {
	/**
	 * Build a real child session through the parent's delegation runtime -- the
	 * same `buildChildSession` seam a live delegation and a historical reattach
	 * use -- and return the handle. Driving the handle directly (instead of
	 * through the delegate tool) keeps the parent's own Agent idle, so every
	 * provider request and every budget gate observation below belongs to the
	 * children under test.
	 */
	async function buildChild(
		delegationRuntime: DelegationRuntimeOptions,
		agentType: "scout" | "writer",
		sessionId: string,
		artifactDir?: string,
	) {
		const definition = AGENT_DEFINITIONS[agentType];
		const toolNames = agentType === "writer" ? ["write"] : ["read"];
		// The admitted capability set, derived through the same runtime projection
		// the real admission path uses (the sdk only reports it onward).
		const capabilities = new Set<Capability>();
		for (const toolName of toolNames) {
			for (const capability of delegationRuntime.getToolCapabilities(toolName) ?? new Set()) {
				capabilities.add(capability);
			}
		}
		return delegationRuntime.buildChildSession({
			agentType,
			definition,
			toolNames,
			capabilities,
			depth: 1,
			sessionId,
			...(artifactDir ? { artifactDir } : {}),
		});
	}

	it("continues one child budget across sendInput turns: the third turn is refused at the gate", async () => {
		const { faux, delegationRuntime } = await buildParentSession("budget-continuity-e2e", {
			runBudget: { maxProviderRequests: 2 },
		});
		const child = await buildChild(delegationRuntime!, "scout", "budget-continuity-child");

		faux.setResponses([
			fauxAssistantMessage("first recon", { stopReason: "stop" }),
			fauxAssistantMessage("second recon", { stopReason: "stop" }),
		]);
		await child.run("recon one");
		expect(faux.state.callCount).toBe(1);

		// The follow-up turn continues the SAME budget: this is the last request
		// the small per-run max allows.
		await child.sendInput("recon two");
		expect(faux.state.callCount).toBe(2);

		// A third turn is refused at the gate before any provider request fires.
		// Under per-prompt scope it would start a fresh controller and send.
		faux.setResponses([fauxAssistantMessage("third recon", { stopReason: "stop" })]);
		await child.sendInput("recon three");
		expect(faux.state.callCount).toBe(2);
		expect(child.latestResult()).toMatchObject({ output: "second recon" });

		child.dispose();
	});

	it("parent runs consume the configured aggregate budget", async () => {
		const { session, faux } = await buildParentSession("aggregate-parent-e2e", {
			aggregateBudget: { maxProviderRequests: 2 },
		});
		const stopReasons: unknown[] = [];
		session.agent.subscribe((event) => {
			if (event.type === "agent_end") stopReasons.push(event.stopReason);
		});
		// The snapshot exists from construction, before any run.
		expect(session.aggregateBudgetUsage()).toEqual({
			providerRequests: 0,
			toolCalls: 0,
			maintenanceRequests: 0,
			startedAtMs: expect.any(Number),
		});

		faux.setResponses([
			fauxAssistantMessage("first parent turn", { stopReason: "stop" }),
			fauxAssistantMessage("second parent turn", { stopReason: "stop" }),
		]);
		await session.prompt("one");
		await session.prompt("two");
		expect(faux.state.callCount).toBe(2);
		// The parent's own runs consume the aggregate across prompts (the shared
		// controller is never reset by a prompt; only the local per-prompt one is).
		expect(session.aggregateBudgetUsage()).toMatchObject({ providerRequests: 2 });

		// The third prompt is refused at the aggregate gate before any request.
		faux.setResponses([fauxAssistantMessage("third parent turn", { stopReason: "stop" })]);
		await session.prompt("three");
		expect(faux.state.callCount).toBe(2);
		expect(stopReasons[2]).toEqual({ kind: "budget-exhausted", limit: "provider-requests" });
		expect(session.aggregateBudgetUsage()).toMatchObject({ providerRequests: 2 });
		session.dispose();
	});

	it("grandchildren share the root aggregate ledger, not a fresh per-parent ledger", async () => {
		// Root (depth 0) -> child (depth 1) -> grandchild (depth 2) through nested
		// delegation. Every session's OWN controller is fresh with the settings
		// default policy, so only the root aggregate can explain a refusal after
		// four accepted requests spread across three different sessions.
		const { session, faux } = await buildParentSession("aggregate-grandchild-e2e", {
			aggregateBudget: { maxProviderRequests: 4 },
			agentDefinitions: {
				scout: {
					name: "scout",
					description: "recon, can delegate further",
					tools: ["read", "delegate"],
					systemPrompt: "You are a scout.",
				},
			},
		});
		const stopReasons: unknown[] = [];
		session.agent.subscribe((event) => {
			if (event.type === "agent_end") stopReasons.push(event.stopReason);
		});

		const rootCall = fauxToolCall("delegate", { agentType: "scout", task: "T1" });
		const childCall = fauxToolCall("delegate", { agentType: "scout", task: "T2" });
		faux.setResponses([
			fauxAssistantMessage([rootCall], { stopReason: "toolUse" }), // root request 1
			fauxAssistantMessage([childCall], { stopReason: "toolUse" }), // child request 2
			fauxAssistantMessage("grandchild done", { stopReason: "stop" }), // grandchild request 3
			fauxAssistantMessage("child done", { stopReason: "stop" }), // child request 4 -- aggregate now full
		]);
		await session.prompt("go");

		// Requests 1-4 across root, child, and grandchild were all accepted
		// against the ONE root aggregate (4 of 4), and both delegate tool calls
		// recorded to it too. A fresh per-parent ledger at the child would have
		// left the aggregate half empty.
		expect(faux.state.callCount).toBe(4);
		expect(session.aggregateBudgetUsage()).toEqual({
			providerRequests: 4,
			toolCalls: 2,
			maintenanceRequests: 0,
			startedAtMs: expect.any(Number),
		});

		// The root's final turn is the tree's fifth request: refused at the
		// aggregate gate before any request fires.
		expect(stopReasons[0]).toEqual({ kind: "budget-exhausted", limit: "provider-requests" });
		session.dispose();
	});

	it("without aggregateBudget children keep local-only budgets and do not share a ceiling", async () => {
		const { faux, delegationRuntime } = await buildParentSession("local-only-budgets-e2e", {
			runBudget: { maxProviderRequests: 1 },
		});
		const childA = await buildChild(delegationRuntime!, "scout", "local-only-child-a");
		const childB = await buildChild(delegationRuntime!, "scout", "local-only-child-b");

		// Each child's first turn sends: the local controllers are independent,
		// and with no aggregateBudget there is no shared ceiling at all (the
		// removed family-ledger-from-runBudget behavior would have refused B here).
		faux.setResponses([
			fauxAssistantMessage("a recon", { stopReason: "stop" }),
			fauxAssistantMessage("b recon", { stopReason: "stop" }),
		]);
		await childA.run("recon");
		await childB.run("recon");
		expect(faux.state.callCount).toBe(2);

		// Each child's own per-run policy is still enforced locally: A's second
		// turn is refused at its own gate and never sends.
		faux.setResponses([fauxAssistantMessage("a again", { stopReason: "stop" })]);
		await childA.sendInput("recon again");
		expect(faux.state.callCount).toBe(2);
		expect(childA.latestResult()).toMatchObject({ output: "a recon", outcome: "completed" });

		childA.dispose();
		childB.dispose();
	});

	it("exhausts the aggregate budget across two children: the second child's second write is refused at the gate, naming the limit", async () => {
		const { faux, delegationRuntime } = await buildParentSession("aggregate-budget-e2e", {
			tools: ["read", "write", "delegate"],
			rules: [
				{ toolName: "write", behavior: "allow", ruleContent: "a.txt" },
				{ toolName: "write", behavior: "allow", ruleContent: "b1.txt" },
				{ toolName: "write", behavior: "allow", ruleContent: "b2.txt" },
			],
			aggregateBudget: { maxToolCalls: 2 },
		});
		const childA = await buildChild(delegationRuntime!, "writer", "family-child-a");
		const childBDir = join(scratch, "delegations", "family-child-b");
		mkdirSync(childBDir, { recursive: true });
		const childB = await buildChild(delegationRuntime!, "writer", "family-child-b", childBDir);

		// Child A spends the aggregate's first tool call.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "child output" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("a done", { stopReason: "stop" }),
		]);
		await childA.run("write a.txt");
		expect(await readFile(join(scratch, "a.txt"), "utf8")).toBe("child output");

		// Child B's own controller is fresh, but the composite gate answers to the
		// root aggregate too: its first write is the aggregate's second and last
		// accepted call, and the second write in the same batch is refused with
		// the limit named and never executes.
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "b1.txt", content: "child output" }),
					fauxToolCall("write", { path: "b2.txt", content: "child output" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await childB.run("write b1.txt and b2.txt");
		expect(await readFile(join(scratch, "b1.txt"), "utf8")).toBe("child output");
		await expect(access(join(scratch, "b2.txt"))).rejects.toThrow();

		// The refusal names the exhausted limit in the child's own transcript.
		const transcript = (await readdir(childBDir)).find((name) => name.endsWith("_family-child-b.jsonl"));
		if (!transcript) throw new Error("expected a child session file under the artifact dir");
		const transcriptText = await readFile(join(childBDir, transcript), "utf8");
		expect(transcriptText).toContain("budget was exhausted");
		expect(transcriptText).toContain("tool-calls");

		childA.dispose();
		childB.dispose();
	});

	it("fails a run whose queued follow-up settles under a failing post-turn verification policy", async () => {
		const { faux, delegationRuntime } = await buildParentSession("verify-followup-e2e", {
			settings: {
				policies: {
					schemaVersion: 1,
					boundary: "post-turn",
					verification: [
						{
							id: "child-check",
							executable: process.execPath,
							argv: ["-e", "process.exit(1)"],
							permission: "allow",
							blocksCompletion: true,
						},
					],
				},
			},
		});
		const child = await buildChild(delegationRuntime!, "scout", "verify-followup-child");

		faux.setResponses([
			fauxAssistantMessage("first recon", { stopReason: "stop" }),
			fauxAssistantMessage("second recon", { stopReason: "stop" }),
		]);
		const run = child.run("recon one");
		// Queue the follow-up while the first turn is still live: it settles
		// inside the SAME run (both turns fire), through the child session's own
		// post-turn verification boundary.
		await child.sendInput("recon two");
		await expect(run).rejects.toThrow(/verification failed: failed/i);
		// The follow-up really settled inside the run, and the settled outcome is
		// failed -- never completed -- with the failing policy named.
		expect(faux.state.callCount).toBe(2);
		expect(child.latestResult()).toMatchObject({ outcome: "failed" });
		expect(child.latestResult()?.output).toContain("child-check");

		child.dispose();
	});
});

describe("worktree isolation through the real git workspace owner (spec 2026-09-09, phase D)", () => {
	function git(cwd: string, ...args: string[]): string {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout.trim();
	}

	/**
	 * Committed scratch repository. `git worktree add -b` needs a HEAD, and a
	 * committed .gitignore keeps the harness's own bookkeeping (the session
	 * agent dir and the permission store's project/local files) out of the
	 * parent-checkout status assertions below -- the same by-path policy this
	 * repo's own .gitignore applies.
	 */
	function initScratchRepo(): void {
		writeFileSync(
			join(scratch, ".gitignore"),
			"agent/\n.apex-code/permissions.json\n.apex-code/permissions.local.json\n",
			"utf-8",
		);
		git(scratch, "init", "-b", "main");
		git(scratch, "config", "user.email", "delegation-e2e@example.com");
		git(scratch, "config", "user.name", "delegation-e2e");
		git(scratch, "add", "-A");
		git(scratch, "commit", "-m", "init");
	}

	/** Where the owner is specified to put one child's worktree. */
	function worktreeRoot(handleId: string): string {
		return join(scratch, ".apex-code", "worktrees", handleId);
	}

	/** The child session file's header records the cwd the child actually ran in. */
	async function childHeaderCwd(
		session: Awaited<ReturnType<typeof buildParentSession>>["session"],
		handleId: string,
	): Promise<string> {
		const dir = join(session.sessionManager.getSessionDir(), "delegations", handleId);
		const file = (await readdir(dir)).find((name) => name.endsWith(".jsonl"));
		if (!file) throw new Error(`no child session file under ${dir}`);
		const header = JSON.parse((await readFile(join(dir, file), "utf8")).split("\n", 1)[0]!) as { cwd?: string };
		return header.cwd ?? "";
	}

	/** One real writer child, launched through runDelegation with the requested workspace. */
	async function runWriterDelegation(
		delegationRuntime: DelegationRuntimeOptions,
		faux: Awaited<ReturnType<typeof buildParentSession>>["faux"],
		input: { handleId: string; path: string; workspace: ChildWorkspaceRequest },
	) {
		const writeCall = fauxToolCall("write", { path: input.path, content: "child output" });
		faux.setResponses([
			fauxAssistantMessage([writeCall], { stopReason: "toolUse" }), // the child's write
			fauxAssistantMessage("child wrote its file", { stopReason: "stop" }), // the child's final turn
			fauxAssistantMessage("parent noted the delegation", { stopReason: "stop" }), // the parent's turn
		]);
		return runDelegation(delegationRuntime, "writer", `write ${input.path}`, {
			handleId: input.handleId,
			workspace: input.workspace,
		});
	}

	it("runs a worktree-isolated child inside its worktree: the write lands there, not in the parent checkout", async () => {
		initScratchRepo();
		const { session, faux, delegationRuntime } = await buildParentSession("worktree-e2e-1", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "wt-output.txt" }],
		});
		const handleId = "wt-e2e-child";
		// The sdk wired the real production owner, lazily constructed at first use.
		expect(delegationRuntime!.workspaceOwner).toBeInstanceOf(GitWorktreeWorkspaceOwner);
		await runWriterDelegation(delegationRuntime!, faux, {
			handleId,
			path: "wt-output.txt",
			workspace: { isolation: "worktree", ownedPaths: [] },
		});

		// The write exists inside the prepared worktree and nowhere in the parent checkout.
		expect(await readFile(join(worktreeRoot(handleId), "wt-output.txt"), "utf8")).toBe("child output");
		await expect(access(join(scratch, "wt-output.txt"))).rejects.toThrow();

		// The child session really ran with the worktree as its cwd (recorded header).
		expect(await childHeaderCwd(session, handleId)).toBe(worktreeRoot(handleId));

		// The worktrees directory never pollutes the parent checkout's status.
		expect(git(scratch, "status", "--porcelain", "-uall")).toBe("");

		session.dispose();
	});

	it("release keeps a dirty worktree: directory and file intact, loud warning, outcome kept:'dirty'", async () => {
		initScratchRepo();
		const { session, faux, delegationRuntime } = await buildParentSession("worktree-e2e-2", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "wt-output.txt" }],
		});
		const handleId = "wt-release";
		await runWriterDelegation(delegationRuntime!, faux, {
			handleId,
			path: "wt-output.txt",
			workspace: { isolation: "worktree", ownedPaths: [] },
		});
		expect(existsSync(worktreeRoot(handleId))).toBe(true);

		// The child left an untracked file in the worktree, so plain `git worktree
		// remove` refuses -- and the owner must keep the tree, never force it.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const owner = delegationRuntime!.workspaceOwner!;
			await expect(owner.release(handleId)).resolves.toMatchObject({
				removed: false,
				kept: "dirty",
				dir: worktreeRoot(handleId),
			});
			// The directory and the child's uncommitted file survive.
			expect(existsSync(worktreeRoot(handleId))).toBe(true);
			expect(await readFile(join(worktreeRoot(handleId), "wt-output.txt"), "utf8")).toBe("child output");
			expect(git(scratch, "worktree", "list")).toContain(handleId);

			// Disposing the parent drives the registry's own release of the
			// tracked workspace: it records the outcome and warns loudly.
			session.dispose();
			const deadline = Date.now() + 5_000;
			while (
				Date.now() < deadline &&
				delegationRuntime!.childRunRegistry?.workspaceReleaseOutcome(handleId) === undefined
			) {
				await sleep(25);
			}
			expect(delegationRuntime!.childRunRegistry?.workspaceReleaseOutcome(handleId)).toMatchObject({
				removed: false,
				kept: "dirty",
				dir: worktreeRoot(handleId),
			});
			const warned = warn.mock.calls.flat().join("\n");
			expect(warned).toContain(worktreeRoot(handleId));
			expect(warned).toMatch(/uncommitted child work preserved/i);
			expect(warned).toMatch(/git worktree remove --force/);
		} finally {
			warn.mockRestore();
		}
	});

	it("force:true is the explicit escape hatch that removes a dirty worktree", async () => {
		initScratchRepo();
		const { session, faux, delegationRuntime } = await buildParentSession("worktree-e2e-force", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "wt-output.txt" }],
		});
		const handleId = "wt-force";
		await runWriterDelegation(delegationRuntime!, faux, {
			handleId,
			path: "wt-output.txt",
			workspace: { isolation: "worktree", ownedPaths: [] },
		});
		expect(existsSync(worktreeRoot(handleId))).toBe(true);

		const owner = delegationRuntime!.workspaceOwner!;
		await expect(owner.release(handleId, { force: true })).resolves.toEqual({ removed: true });
		expect(existsSync(worktreeRoot(handleId))).toBe(false);
		expect(git(scratch, "worktree", "list")).not.toContain(handleId);
		// Releasing twice is a no-op, not an error.
		await expect(owner.release(handleId)).resolves.toEqual({ removed: true });

		session.dispose();
	});

	it("release removes a clean worktree and tolerates a missing directory", async () => {
		initScratchRepo();
		const { session, delegationRuntime } = await buildParentSession("worktree-e2e-clean", {});
		const owner = delegationRuntime!.workspaceOwner!;
		const handleId = "wt-clean";
		await owner.prepare({ isolation: "worktree", ownedPaths: [], sessionId: handleId });
		expect(existsSync(worktreeRoot(handleId))).toBe(true);
		await expect(owner.release(handleId)).resolves.toEqual({ removed: true });
		expect(existsSync(worktreeRoot(handleId))).toBe(false);
		expect(git(scratch, "worktree", "list")).not.toContain(handleId);
		// A session id that was never prepared is tolerated.
		await expect(owner.release("wt-never-prepared")).resolves.toEqual({ removed: true });

		session.dispose();
	});

	it("disposing the parent session releases a clean worktree child's worktree and keeps a dirty one", async () => {
		initScratchRepo();
		const { session, faux, delegationRuntime } = await buildParentSession("worktree-e2e-dispose", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "wt-output.txt" }],
		});
		const handleId = "wt-dispose";
		await runWriterDelegation(delegationRuntime!, faux, {
			handleId,
			path: "wt-output.txt",
			workspace: { isolation: "worktree", ownedPaths: [] },
		});
		expect(existsSync(worktreeRoot(handleId))).toBe(true);
		expect(git(scratch, "worktree", "list")).toContain(handleId);

		// Disposing the parent session releases the child's workspace -- but a
		// dirty tree is kept, loudly, never force-removed. The release is
		// fire-and-forget inside dispose(), so poll for the recorded outcome.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			session.dispose();
			const deadline = Date.now() + 5_000;
			while (
				Date.now() < deadline &&
				delegationRuntime!.childRunRegistry?.workspaceReleaseOutcome(handleId) === undefined
			) {
				await sleep(25);
			}
			expect(delegationRuntime!.childRunRegistry?.workspaceReleaseOutcome(handleId)).toMatchObject({
				removed: false,
				kept: "dirty",
			});
			expect(existsSync(worktreeRoot(handleId))).toBe(true);
			expect(git(scratch, "worktree", "list")).toContain(handleId);
			expect(warn.mock.calls.flat().join("\n")).toMatch(/uncommitted child work preserved/i);
		} finally {
			warn.mockRestore();
		}
	});

	it("a retained-dirty worktree child classifies, refuses resume with guidance, and recovers explicitly before resuming in the SAME worktree", async () => {
		initScratchRepo();
		const { session, faux, delegationRuntime } = await buildParentSession("worktree-recover-e2e", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "wt-output.txt" }],
		});
		const handleId = "wt-recover";
		await runWriterDelegation(delegationRuntime!, faux, {
			handleId,
			path: "wt-output.txt",
			workspace: { isolation: "worktree", ownedPaths: [] },
		});
		expect(existsSync(worktreeRoot(handleId))).toBe(true);

		// A parent turn flushes the buffered child_run records to the parent
		// session file (custom entries ride the first assistant message's flush),
		// so the reopened parent below restores them.
		faux.setResponses([fauxAssistantMessage("noted the worktree delegation", { stopReason: "stop" })]);
		await session.prompt("acknowledge the delegation");

		// Parent dispose keeps the dirty tree and classifies it on the record.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			session.dispose();
			const deadline = Date.now() + 5_000;
			while (
				Date.now() < deadline &&
				delegationRuntime!.childRunRegistry?.workspaceReleaseOutcome(handleId) === undefined
			) {
				await sleep(25);
			}
			expect(delegationRuntime!.childRunRegistry?.workspaceReleaseOutcome(handleId)).toMatchObject({
				removed: false,
				kept: "dirty",
			});
		} finally {
			warn.mockRestore();
		}

		// Reopen the parent on the same session file: the restored record carries
		// the persisted classification.
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("expected a file-backed parent session");
		const reopened = SessionManager.open(parentSessionFile);
		const { session: resumed, faux: resumedFaux } = await buildParentSession("worktree-recover-e2e", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "wt-output.txt" }],
			sessionManager: reopened,
		});

		const status = resumed.childRunStatus(handleId);
		expect(status).toMatchObject({
			status: "idle",
			workspaceState: "retained-dirty",
			workspace: { isolation: "worktree", root: worktreeRoot(handleId) },
		});

		// Plain resume refuses, naming the persisted state and pointing at
		// explicit recovery instead of silently rebuilding anything.
		await expect(resumed.resumeChildRun(handleId)).rejects.toThrow(/retained-dirty/);
		await expect(resumed.resumeChildRun(handleId)).rejects.toThrow(/recoverChildWorkspace/);

		// Explicit recovery verifies the SAME worktree and reactivates it,
		// reporting the child's uncommitted work.
		await expect(resumed.recoverChildWorkspace(handleId)).resolves.toEqual({
			workspaceState: "active",
			dirty: true,
		});

		// Resume then works inside the SAME worktree: the child session file is
		// reattached, its cwd is the worktree, and the uncommitted file survives.
		resumedFaux.setResponses([fauxAssistantMessage("resumed recon after recovery", { stopReason: "stop" })]);
		await expect(resumed.resumeChildRun(handleId, "continue in the worktree")).resolves.toBe("idle");
		await expect(resumed.waitChildRun(handleId)).resolves.toMatchObject({
			output: "resumed recon after recovery",
			outcome: "completed",
		});
		expect(await readFile(join(worktreeRoot(handleId), "wt-output.txt"), "utf8")).toBe("child output");
		expect(await childHeaderCwd(resumed, handleId)).toBe(worktreeRoot(handleId));

		resumed.dispose();
	});

	it("keeps a shared-read child in the parent checkout: cwd unchanged, no worktree created", async () => {
		initScratchRepo();
		const { session, faux, delegationRuntime } = await buildParentSession("worktree-e2e-3", {
			tools: ["read", "write", "delegate"],
			rules: [{ toolName: "write", behavior: "allow", ruleContent: "shared-output.txt" }],
		});
		const handleId = "shared-e2e-child";
		await runWriterDelegation(delegationRuntime!, faux, {
			handleId,
			path: "shared-output.txt",
			workspace: { isolation: "shared-read", ownedPaths: [] },
		});

		// The child wrote into the parent checkout: its cwd never moved.
		expect(await readFile(join(scratch, "shared-output.txt"), "utf8")).toBe("child output");
		expect(await childHeaderCwd(session, handleId)).toBe(scratch);
		expect(existsSync(worktreeRoot(handleId))).toBe(false);

		session.dispose();
	});

	it("refuses worktree isolation outside a git repository and builds no child", async () => {
		// beforeEach's scratch is deliberately not a git repository here.
		const { session, delegationRuntime } = await buildParentSession("worktree-refusal-e2e", {
			tools: ["read", "write", "delegate"],
		});
		await expect(
			runDelegation(delegationRuntime!, "writer", "write anything", {
				handleId: "wt-refused",
				workspace: { isolation: "worktree", ownedPaths: [] },
			}),
		).rejects.toThrow(/not a git repository/i);
		expect(session.listChildRuns()).toHaveLength(0);

		session.dispose();
	});
});

describe("historical child reattachment and resume (restart reconstruction)", () => {
	/** The child session file for a handle, per SessionManager's `<timestamp>_<sessionId>.jsonl` naming. */
	async function childSessionFile(sessionDir: string, handleId: string): Promise<string> {
		const dir = join(sessionDir, "delegations", handleId);
		const file = (await readdir(dir)).find((name) => name.endsWith(`_${handleId}.jsonl`));
		if (!file) throw new Error(`no child session file under ${dir}`);
		return join(dir, file);
	}

	async function jsonlLines(file: string): Promise<string[]> {
		return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "");
	}

	it("reattaches a completed background child after reopening the parent session: same file identity, history grows", async () => {
		const { session, faux, delegationRuntime } = await buildParentSession("hist-reattach-e2e");
		const handleId = "hist-reattach-child";
		faux.setResponses([fauxAssistantMessage("scout historical recon done", { stopReason: "stop" })]);
		await runDelegation(delegationRuntime!, "scout", "recon the config loader", { background: true, handleId });
		await expect(session.waitChildRun(handleId)).resolves.toMatchObject({
			output: "scout historical recon done",
			outcome: "completed",
		});
		// A later parent turn flushes the buffered child_run records to the parent
		// session file (custom entries ride the first assistant message's flush).
		faux.setResponses([fauxAssistantMessage("noted the background delegation", { stopReason: "stop" })]);
		await session.prompt("acknowledge the delegation");

		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("expected a file-backed parent session");
		const childFile = await childSessionFile(session.sessionManager.getSessionDir(), handleId);
		const linesBefore = await jsonlLines(childFile);
		const headerBefore = JSON.parse(linesBefore[0]!) as { id?: string };
		expect(headerBefore.id).toBe(handleId);

		session.dispose();

		// A fresh session on the SAME parent session file: the registry restores
		// the persisted child_run records (restart reconstruction's starting point).
		const reopened = SessionManager.open(parentSessionFile);
		const { session: resumed, faux: resumedFaux } = await buildParentSession("hist-reattach-e2e", {
			sessionManager: reopened,
		});

		const historical = resumed.listChildRuns().find((run) => run.handleId === handleId);
		expect(historical).toMatchObject({ handleId, agentType: "scout" });

		// The completed run's persisted output is retrievable without reattaching.
		await expect(resumed.waitChildRun(handleId)).resolves.toMatchObject({
			output: "scout historical recon done",
			outcome: "completed",
		});

		// Resume: reattach to the SAME child session file and continue it.
		resumedFaux.setResponses([fauxAssistantMessage("resumed recon continues", { stopReason: "stop" })]);
		await expect(resumed.resumeChildRun(handleId, "continue the recon")).resolves.toBe("idle");
		await expect(resumed.waitChildRun(handleId)).resolves.toMatchObject({
			output: "resumed recon continues",
			outcome: "completed",
		});

		// Identity: same file, same header id; history grew by the resumed turn.
		expect(await childSessionFile(resumed.sessionManager.getSessionDir(), handleId)).toBe(childFile);
		const linesAfter = await jsonlLines(childFile);
		const headerAfter = JSON.parse(linesAfter[0]!) as { id?: string };
		expect(headerAfter.id).toBe(headerBefore.id);
		expect(linesAfter.length).toBeGreaterThan(linesBefore.length);

		resumed.dispose();
	});

	it("refuses to resume a legacy minimal record that was never file-backed, naming the limitation", async () => {
		const registry = new ChildRunRegistry();
		const { session } = await buildParentSession("hist-legacy-e2e", { childRunRegistry: registry });
		registry.restore([{ handleId: "legacy-run", agentType: "scout", status: "interrupted", updatedAt: Date.now() }]);
		expect(session.listChildRuns()).toMatchObject([{ handleId: "legacy-run", agentType: "scout" }]);

		await expect(session.resumeChildRun("legacy-run")).rejects.toThrow(
			/never file-backed|no persisted child session/i,
		);
		session.dispose();
	});

	it("refuses to resume a record whose artifact directory is missing, naming the path", async () => {
		const registry = new ChildRunRegistry();
		const { session } = await buildParentSession("hist-missing-dir-e2e", { childRunRegistry: registry });
		registry.restore([
			{
				handleId: "gone-run",
				agentType: "scout",
				sessionId: "gone-run",
				artifactDir: join(scratch, "delegations", "gone-run"),
				status: "interrupted",
				updatedAt: Date.now(),
			},
		]);

		await expect(session.resumeChildRun("gone-run")).rejects.toThrow(/artifact directory is missing/i);
		session.dispose();
	});
});

describe("child record policy, sandbox, artifact, and evidence linkage (phase 4)", () => {
	it("child records persist the derived policy snapshot and sandbox flag", async () => {
		const { session, faux, delegationRuntime } = await buildParentSession("policy-snapshot-e2e", {
			aggregateBudget: { maxProviderRequests: 5 },
		});
		const handleId = "policy-snapshot-child";
		faux.setResponses([fauxAssistantMessage("scout policy recon done", { stopReason: "stop" })]);
		await runDelegation(delegationRuntime!, "scout", "recon the config loader", { background: true, handleId });
		await expect(session.waitChildRun(handleId)).resolves.toMatchObject({ outcome: "completed" });

		// The live child carries exactly the policy its construction used: the
		// restricted (read-only) definition's tools, the admitted capability set,
		// the sdk's sandbox contract, the delegation bound, the child model, and
		// the budget fields -- aggregate true because the parent configured one.
		const expectedPolicy = {
			tools: ["read"],
			capabilities: ["fs.read"],
			sandbox: "none",
			maxDelegationDepth: delegationRuntime!.maxDelegationDepth,
			model: faux.getModel().id,
			budgetScope: "session",
			aggregateBudget: true,
		};
		expect(session.childRunStatus(handleId).policy).toEqual(expectedPolicy);
		// No enforcing supervisor marker: the OS-containment check did not pass.
		expect(session.childRunStatus(handleId).sandboxEnforced).toBe(false);

		// The durable child_run record persists it: flush the buffered records
		// with a parent turn, then read them back from the parent session file.
		faux.setResponses([fauxAssistantMessage("noted the delegation", { stopReason: "stop" })]);
		await session.prompt("acknowledge the delegation");
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("expected a file-backed parent session");
		session.dispose();

		const records = (await readFile(parentSessionFile, "utf8"))
			.split("\n")
			.filter((line) => line.includes('"child_run"'))
			.map((line) => (JSON.parse(line) as { data?: ChildRunRecord }).data)
			.filter((record): record is ChildRunRecord => record?.handleId === handleId);
		expect(records.length).toBeGreaterThan(0);
		const persisted = records[records.length - 1]!;
		expect(persisted.policy).toEqual(expectedPolicy);
		expect(persisted.sandboxEnforced).toBe(false);
		expect(persisted.parentSessionId).toBeDefined();

		// Reopening the parent loads the record with the same snapshot intact.
		const reopened = await buildParentSession("policy-snapshot-e2e", {
			sessionManager: SessionManager.open(parentSessionFile),
		});
		const restored = reopened.session.childRunStatus(handleId);
		expect(restored.policy).toEqual(expectedPolicy);
		expect(restored.sandboxEnforced).toBe(false);
		reopened.session.dispose();

		// With the enforcing supervisor marker present, the flag reports true:
		// the sdk's OS-containment check passed for this parent session.
		const previousMarker = process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE];
		process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE;
		try {
			const supervised = await buildParentSession("policy-sandbox-marker-e2e");
			const markerHandle = "policy-marker-child";
			supervised.faux.setResponses([fauxAssistantMessage("supervised recon done", { stopReason: "stop" })]);
			await runDelegation(supervised.delegationRuntime!, "scout", "recon under supervision", {
				background: true,
				handleId: markerHandle,
			});
			const markerStatus = supervised.session.childRunStatus(markerHandle);
			expect(markerStatus.sandboxEnforced).toBe(true);
			expect(markerStatus.policy?.sandbox).toBe("none");
			supervised.session.dispose();
		} finally {
			if (previousMarker === undefined) delete process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE];
			else process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = previousMarker;
		}
	});

	it("wait and status surface artifact, session file, parent linkage, policy, and sandbox", async () => {
		const { session, faux, delegationRuntime } = await buildParentSession("linkage-e2e");
		const handleId = "linkage-child";
		faux.setResponses([fauxAssistantMessage("scout linkage recon done", { stopReason: "stop" })]);
		await runDelegation(delegationRuntime!, "scout", "recon the config loader", { background: true, handleId });

		const artifactDir = join(session.sessionManager.getSessionDir(), "delegations", handleId);
		const waited = await session.waitChildRunResult(handleId);
		expect(waited).toMatchObject({
			status: "idle",
			output: "scout linkage recon done",
			outcome: "completed",
			artifactDir,
			parentSessionId: session.sessionManager.getSessionId(),
			policy: {
				tools: ["read"],
				capabilities: ["fs.read"],
				sandbox: "none",
				maxDelegationDepth: delegationRuntime!.maxDelegationDepth,
				budgetScope: "session",
				aggregateBudget: false,
			},
			sandboxEnforced: false,
		});
		// The transcript path resolves lazily to the child's real session file,
		// which exists on disk under the per-child artifact directory.
		expect(typeof waited.sessionFile).toBe("string");
		expect(existsSync(waited.sessionFile!)).toBe(true);
		expect(waited.sessionFile!.startsWith(artifactDir)).toBe(true);
		expect(basename(waited.sessionFile!)).toMatch(new RegExp(`_${handleId}\\.jsonl$`));

		// The non-blocking status payload carries the same linkage.
		const status = session.childRunStatus(handleId);
		expect(status).toMatchObject({
			artifactDir,
			parentSessionId: session.sessionManager.getSessionId(),
			policy: {
				tools: ["read"],
				capabilities: ["fs.read"],
				sandbox: "none",
				maxDelegationDepth: delegationRuntime!.maxDelegationDepth,
				budgetScope: "session",
				aggregateBudget: false,
			},
			sandboxEnforced: false,
		});
		expect(status.sessionFile).toBe(waited.sessionFile);
		session.dispose();
	});

	it("legacy records without policy and sandbox fields load and status omits them", async () => {
		const registry = new ChildRunRegistry();
		const { session } = await buildParentSession("legacy-linkage-e2e", { childRunRegistry: registry });
		registry.restore([
			{
				handleId: "legacy-linkage-run",
				agentType: "scout",
				status: "completed",
				updatedAt: Date.now(),
				latestResult: { output: "old scout output", outcome: "completed" },
			},
		]);

		const status = session.childRunStatus("legacy-linkage-run");
		expect(status.handleId).toBe("legacy-linkage-run");
		expect(status.policy).toBeUndefined();
		expect(status.sandboxEnforced).toBeUndefined();
		expect(status.artifactDir).toBeUndefined();
		expect(status.sessionFile).toBeUndefined();
		expect(status.parentSessionId).toBeUndefined();

		// wait works unchanged and carries no half-populated linkage.
		const waited = await session.waitChildRunResult("legacy-linkage-run");
		expect(waited).toMatchObject({ output: "old scout output", outcome: "completed" });
		expect(waited.policy).toBeUndefined();
		expect(waited.sandboxEnforced).toBeUndefined();
		session.dispose();
	});
});

describe("child usage and cost accounting (phase 5)", () => {
	/** Known faux usage, chosen so sums are exact in binary floating point. */
	const USAGE_A: Usage = {
		input: 100,
		output: 10,
		cacheRead: 5,
		cacheWrite: 7,
		totalTokens: 122,
		cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.0625, total: 0.9375 },
	};
	const USAGE_B: Usage = {
		input: 30,
		output: 4,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 37,
		cost: { input: 0.25, output: 0.125, cacheRead: 0.0625, cacheWrite: 0.03125, total: 0.46875 },
	};
	/** USAGE_A + USAGE_B. */
	const EXPECTED_TOTALS = {
		inputTokens: 130,
		outputTokens: 14,
		cacheReadTokens: 7,
		cacheWriteTokens: 8,
		totalTokens: 159,
		cost: { input: 0.75, output: 0.375, cacheRead: 0.1875, cacheWrite: 0.09375, total: 1.40625 },
	};

	/** An assistant message carrying known usage (fauxAssistantMessage's shape, usage overridden). */
	function usageAssistantMessage(text: string, usage: Usage) {
		return { ...fauxAssistantMessage(text), usage };
	}

	/**
	 * The child's own transcript is the one source of the rollup: write a real
	 * two-turn child session (SessionManager naming, valid header) with known
	 * usage under the artifact directory runDelegation created.
	 */
	function writeChildTranscriptWithUsage(artifactDir: string, sessionId: string): string {
		const child = SessionManager.create(scratch, artifactDir, { id: sessionId });
		child.appendMessage(usageAssistantMessage("scout turn one", USAGE_A));
		child.appendMessage(usageAssistantMessage("scout turn two", USAGE_B));
		const file = child.getSessionFile();
		if (!file) throw new Error("expected a file-backed child transcript");
		return file;
	}

	/** A stub handle standing in for the constructed child (no provider traffic). */
	function stubUsageChildHandle(output: string): ChildSessionHandle {
		let latest: { outcome: "completed"; output: string } | undefined;
		return {
			status: "idle",
			run: async () => {
				latest = { outcome: "completed", output };
				return { output };
			},
			latestResult: () => latest,
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput: async () => {
				latest = { outcome: "completed", output };
			},
			followUp: async () => {},
			dispose: () => {},
		};
	}

	it("child usage totals roll up tokens and cost from the child transcript", async () => {
		const { session, delegationRuntime } = await buildParentSession("usage-rollup-e2e");
		const handleId = "usage-rollup-child";
		// Stub the one construction seam: the rollup reads the child's own
		// transcript (written here with known usage), so no provider traffic is
		// needed and the expected sums are exact.
		delegationRuntime!.buildChildSession = async (request) => {
			if (!request.artifactDir) throw new Error("expected an artifact dir");
			writeChildTranscriptWithUsage(request.artifactDir, request.sessionId);
			return stubUsageChildHandle("usage stub output");
		};
		await runDelegation(delegationRuntime!, "scout", "recon the config loader", { background: true, handleId });
		await expect(session.waitChildRun(handleId)).resolves.toMatchObject({
			output: "usage stub output",
			outcome: "completed",
		});

		const totals = session.childRunUsageTotals(handleId);
		expect(totals).toMatchObject({ ...EXPECTED_TOTALS, entriesCounted: 2 });
		expect(typeof totals!.asOf).toBe("number");

		// The status payload carries the same rollup flattened onto `tokens` and
		// `cost`, beside the existing request-count `usage`.
		const status = session.childRunStatus(handleId);
		expect(status.tokens).toEqual({
			inputTokens: 130,
			outputTokens: 14,
			cacheReadTokens: 7,
			cacheWriteTokens: 8,
			totalTokens: 159,
		});
		expect(status.cost).toEqual(EXPECTED_TOTALS.cost);
		session.dispose();
	});

	it("usage totals survive restart from the persisted transcript", async () => {
		const { session, faux, delegationRuntime } = await buildParentSession("usage-restart-e2e");
		const handleId = "usage-restart-child";
		delegationRuntime!.buildChildSession = async (request) => {
			if (!request.artifactDir) throw new Error("expected an artifact dir");
			writeChildTranscriptWithUsage(request.artifactDir, request.sessionId);
			return stubUsageChildHandle("usage stub output");
		};
		await runDelegation(delegationRuntime!, "scout", "recon the config loader", { background: true, handleId });
		await expect(session.waitChildRun(handleId)).resolves.toMatchObject({ outcome: "completed" });

		// A parent turn flushes the buffered child_run record to the parent
		// session file (custom entries ride the first assistant message's flush).
		faux.setResponses([fauxAssistantMessage("noted the delegation", { stopReason: "stop" })]);
		await session.prompt("acknowledge the delegation");
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("expected a file-backed parent session");
		session.dispose();

		// Reopen the parent on the same session file: the historical record has
		// no live child, so the rollup must come from the persisted transcript.
		const reopened = await buildParentSession("usage-restart-e2e", {
			sessionManager: SessionManager.open(parentSessionFile),
		});
		expect(reopened.session.childRunUsageTotals(handleId)).toMatchObject({ ...EXPECTED_TOTALS, entriesCounted: 2 });
		const status = reopened.session.childRunStatus(handleId);
		expect(status.tokens).toEqual({
			inputTokens: 130,
			outputTokens: 14,
			cacheReadTokens: 7,
			cacheWriteTokens: 8,
			totalTokens: 159,
		});
		expect(status.cost).toEqual(EXPECTED_TOTALS.cost);
		reopened.session.dispose();
	});
});
