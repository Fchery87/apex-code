import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLifecycleCommand } from "../../src/cli/agent-lifecycle.ts";
import { parseCliCommand } from "../../src/cli/args.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { AgentDefinition } from "../../src/core/delegation/runtime.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { requiresSandboxedChild } from "../../src/core/sandbox/cli-launch.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { scratchDir } from "../suite/scratch.ts";

// ---------------------------------------------------------------------------
// Classification: parseCliCommand + requiresSandboxedChild (pure, no state)
// ---------------------------------------------------------------------------

describe("agent lifecycle CLI classification", () => {
	it("classifies `agent <operation>` as a session-kind command, so it runs as a sandboxed child", () => {
		const parsed = parseCliCommand(["agent", "wait", "child-1"]);
		expect(parsed.kind).toBe("session");
		if (parsed.kind !== "session") return;
		expect(parsed.args.agent).toEqual({ operation: "wait", childId: "child-1" });
		expect(parsed.args.messages).toEqual([]);
		expect(requiresSandboxedChild(parsed)).toBe(true);
	});

	it("parses the subcommand after flags and consumes its positionals", () => {
		const parsed = parseCliCommand(["--session", "s.jsonl", "agent", "send", "child-1", "fix", "the", "bug"]);
		expect(parsed.kind).toBe("session");
		if (parsed.kind !== "session") return;
		expect(parsed.args.agent).toEqual({ operation: "send", childId: "child-1", input: "fix the bug" });
		expect(parsed.args.session).toBe("s.jsonl");
		expect(parsed.args.messages).toEqual([]);
	});

	it("does not overload bare top-level verbs that collide with host commands", () => {
		const list = parseCliCommand(["list"]);
		expect(list.kind).toBe("host");
		if (list.kind !== "host") return;
		expect(list.args.agent).toBeUndefined();
		expect(parseCliCommand(["auth", "print-api-key"]).kind).toBe("host");
	});

	it("keeps `agent --help` a metadata command", () => {
		expect(parseCliCommand(["agent", "--help"]).kind).toBe("metadata");
	});

	it("rejects a lifecycle command without a resumable session source", () => {
		const parsed = parseCliCommand(["agent", "list"]);
		if (parsed.kind !== "session") throw new Error("expected session kind");
		expect(parsed.args.diagnostics).toEqual([
			expect.objectContaining({
				type: "error",
				message: expect.stringMatching(/--session.*--continue|agent list/is),
			}),
		]);
	});

	it("accepts --continue as the resumable session source", () => {
		const parsed = parseCliCommand(["--continue", "agent", "list"]);
		if (parsed.kind !== "session") throw new Error("expected session kind");
		expect(parsed.args.diagnostics).toEqual([]);
		expect(parsed.args.agent).toEqual({ operation: "list" });
	});

	it("reports invalid usage as parse diagnostics", () => {
		const cases: readonly (readonly string[])[] = [
			["agent"],
			["agent", "frobnicate", "child-1"],
			["agent", "wait"],
			["agent", "wait", "child-1", "extra"],
			["agent", "list", "child-1"],
			["agent", "send", "child-1"],
		];
		for (const argv of cases) {
			const parsed = parseCliCommand([...argv]);
			if (parsed.kind !== "session") throw new Error(`expected session kind for ${argv.join(" ")}`);
			expect(parsed.args.diagnostics, argv.join(" ")).toEqual([
				expect.objectContaining({ type: "error", message: expect.any(String) }),
			]);
			expect(parsed.args.agent, argv.join(" ")).toBeUndefined();
		}
	});

	it("accepts an optional input override for resume", () => {
		const parsed = parseCliCommand(["--session", "s.jsonl", "agent", "resume", "child-1", "continue with tests"]);
		if (parsed.kind !== "session") throw new Error("expected session kind");
		expect(parsed.args.agent).toEqual({ operation: "resume", childId: "child-1", input: "continue with tests" });
		expect(parsed.args.diagnostics).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Execution: the operation runs against the loaded session's own registry
// ---------------------------------------------------------------------------

let scratch: string;
let previousCwd: string;

beforeEach(async () => {
	scratch = await scratchDir("apex-agent-lifecycle-");
	previousCwd = process.cwd();
	process.chdir(scratch);
});

afterEach(async () => {
	process.chdir(previousCwd);
	await rm(scratch, { recursive: true, force: true });
});

const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
	scout: { name: "scout", description: "Fast recon", tools: ["read"], systemPrompt: "You are a scout." },
};

async function buildParentSession(providerId: string) {
	const faux = fauxProvider({ provider: providerId });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [providerId] });
	const settingsManager = SettingsManager.create(scratch, join(scratch, "agent"));
	const store = new FilePermissionRuleStore({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		policyPath: join(scratch, "missing-policy.json"),
	});
	await store.apply({ type: "addRules", destination: "local", rules: [{ toolName: "delegate", behavior: "allow" }] });
	const { session } = await createAgentSession({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager,
		tools: ["read", "delegate"],
		permissionGate: { store, getMode: () => "default" },
		delegation: { resolveAgent: (agentType) => AGENT_DEFINITIONS[agentType] },
	});
	await session.bindExtensions({});
	return { session, faux };
}

/** Run a foreground delegation so the session owns one real, completed child run. */
async function delegateScoutTask(
	session: AgentSession,
	faux: ReturnType<typeof fauxProvider>,
	outputText = "scout found it in config.ts",
): Promise<string> {
	const delegateCall = fauxToolCall("delegate", { agentType: "scout", task: "find the config loader" });
	faux.setResponses([
		fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
		fauxAssistantMessage(outputText, { stopReason: "stop" }), // the child's own turn
		fauxAssistantMessage("Delegation complete.", { stopReason: "stop" }), // the parent's turn after the result
	]);
	await session.prompt("delegate to scout");
	const [child] = session.listChildRuns();
	if (!child) throw new Error("expected the delegate call to register a child run");
	return child.handleId;
}

/** Interrupt the child during a follow-up turn, leaving it in the interrupted state. */
async function interruptDuringFollowUp(
	session: AgentSession,
	faux: ReturnType<typeof fauxProvider>,
	handleId: string,
): Promise<void> {
	faux.setResponses([fauxAssistantMessage("working on it", { stopReason: "stop" })]);
	const pending = session.sendChildInput(handleId, "keep going");
	session.interruptChildRun(handleId);
	await expect(pending).rejects.toThrow(/interrupt/i);
	expect(session.listChildRuns().find((run) => run.handleId === handleId)?.status).toBe("interrupted");
}

function captureWrites(stream: "stdout" | "stderr") {
	const chunks: string[] = [];
	const target = stream === "stdout" ? process.stdout : process.stderr;
	const spy = vi.spyOn(target, "write").mockImplementation(((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof target.write);
	return {
		text: () => chunks.join(""),
		stop: () => spy.mockRestore(),
	};
}

describe("agent lifecycle execution", () => {
	it("lists an empty registry as bounded JSON and as one text line", async () => {
		const { session } = await buildParentSession("agent-lifecycle-list-empty");
		try {
			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(session, { operation: "list" }, { json: true });
			out.stop();
			expect(code).toBe(0);
			expect(JSON.parse(out.text())).toEqual({ operation: "list", agents: [] });

			const textOut = captureWrites("stdout");
			const textCode = await runAgentLifecycleCommand(session, { operation: "list" }, { json: false });
			textOut.stop();
			expect(textCode).toBe(0);
			expect(textOut.text()).toBe("No child runs.\n");
		} finally {
			session.dispose();
		}
	});

	it("lists real child runs with id, agent type, and status", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-list");
		try {
			const handleId = await delegateScoutTask(session, faux);

			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(session, { operation: "list" }, { json: true });
			out.stop();
			expect(code).toBe(0);
			expect(JSON.parse(out.text())).toEqual({
				operation: "list",
				agents: [{ handleId, agentType: "scout", status: "idle", task: "find the config loader", attemptCount: 1 }],
			});

			const textOut = captureWrites("stdout");
			const textCode = await runAgentLifecycleCommand(session, { operation: "list" }, { json: false });
			textOut.stop();
			expect(textCode).toBe(0);
			expect(textOut.text()).toBe(`${handleId} scout idle\n`);
		} finally {
			session.dispose();
		}
	});

	it("wait prints the run's recorded result as bounded JSON", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-wait-json");
		try {
			const handleId = await delegateScoutTask(session, faux);
			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(session, { operation: "wait", childId: handleId }, { json: true });
			out.stop();
			expect(code).toBe(0);
			expect(JSON.parse(out.text())).toEqual({
				operation: "wait",
				childId: handleId,
				result: {
					handleId,
					agentType: "scout",
					task: "find the config loader",
					output: "scout found it in config.ts",
					outputTruncated: false,
				},
			});
		} finally {
			session.dispose();
		}
	});

	it("wait truncates oversized output in JSON mode and keeps text to one line", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-wait-bound");
		try {
			const handleId = await delegateScoutTask(session, faux, `${"x".repeat(2500)}\nsecond line`);

			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(session, { operation: "wait", childId: handleId }, { json: true });
			out.stop();
			expect(code).toBe(0);
			const parsed = JSON.parse(out.text()) as {
				result: { output: string; outputTruncated: boolean };
			};
			expect(parsed.result.outputTruncated).toBe(true);
			expect(parsed.result.output).toHaveLength(2000);

			const textOut = captureWrites("stdout");
			const textCode = await runAgentLifecycleCommand(
				session,
				{ operation: "wait", childId: handleId },
				{ json: false },
			);
			textOut.stop();
			expect(textCode).toBe(0);
			const text = textOut.text();
			expect(text.endsWith("\n")).toBe(true);
			expect(text.slice(0, -1).includes("\n")).toBe(false);
			expect(text).toContain(`${handleId} scout:`);
			// One line means the first line of the output, bounded with an ellipsis.
			expect(text).toContain("...");
			expect(text).not.toContain("second line");
		} finally {
			session.dispose();
		}
	});

	it("send delivers input to a completed child and reports the observed status", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-send");
		try {
			const handleId = await delegateScoutTask(session, faux);
			faux.setResponses([fauxAssistantMessage("follow-up complete", { stopReason: "stop" })]);

			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(
				session,
				{ operation: "send", childId: handleId, input: "continue investigating" },
				{ json: true },
			);
			out.stop();
			expect(code).toBe(0);
			expect(JSON.parse(out.text())).toEqual({ operation: "send", childId: handleId, status: "idle" });

			const textOut = captureWrites("stdout");
			faux.setResponses([fauxAssistantMessage("another follow-up", { stopReason: "stop" })]);
			const textCode = await runAgentLifecycleCommand(
				session,
				{ operation: "send", childId: handleId, input: "again" },
				{ json: false },
			);
			textOut.stop();
			expect(textCode).toBe(0);
			expect(textOut.text()).toBe(`Sent input to child run ${handleId}; status: idle\n`);
		} finally {
			session.dispose();
		}
	});

	it("resume refuses a child that is not interrupted", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-resume-refusal");
		try {
			const handleId = await delegateScoutTask(session, faux);
			const err = captureWrites("stderr");
			const code = await runAgentLifecycleCommand(
				session,
				{ operation: "resume", childId: handleId },
				{ json: true },
			);
			err.stop();
			expect(code).toBe(1);
			expect(err.text()).toMatch(/not interrupted/);
		} finally {
			session.dispose();
		}
	});

	it("resume continues an interrupted child in its existing session", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-resume");
		try {
			const handleId = await delegateScoutTask(session, faux);
			await interruptDuringFollowUp(session, faux, handleId);
			faux.setResponses([fauxAssistantMessage("resumed and finished", { stopReason: "stop" })]);

			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(
				session,
				{ operation: "resume", childId: handleId },
				{ json: true },
			);
			out.stop();
			expect(code).toBe(0);
			expect(JSON.parse(out.text())).toEqual({ operation: "resume", childId: handleId, status: "idle" });
			expect(session.listChildRuns().find((run) => run.handleId === handleId)?.status).toBe("idle");

			// A custom resume input overrides the default resume prompt.
			const handleId2 = await (async () => {
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("delegate", { agentType: "scout", task: "second task" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("second scout output", { stopReason: "stop" }),
					fauxAssistantMessage("Delegation complete.", { stopReason: "stop" }),
				]);
				await session.prompt("delegate again");
				const second = session.listChildRuns().find((run) => run.handleId !== handleId);
				if (!second) throw new Error("expected a second child run");
				return second.handleId;
			})();
			await interruptDuringFollowUp(session, faux, handleId2);
			faux.setResponses([fauxAssistantMessage("resumed with custom input", { stopReason: "stop" })]);
			const code2 = await runAgentLifecycleCommand(
				session,
				{ operation: "resume", childId: handleId2, input: "pick up from the tests" },
				{ json: false },
			);
			expect(code2).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("interrupt and close report observed status and stay idempotent", async () => {
		const { session, faux } = await buildParentSession("agent-lifecycle-interrupt-close");
		try {
			const handleId = await delegateScoutTask(session, faux);
			await interruptDuringFollowUp(session, faux, handleId);

			const out = captureWrites("stdout");
			const code = await runAgentLifecycleCommand(
				session,
				{ operation: "interrupt", childId: handleId },
				{ json: true },
			);
			const again = await runAgentLifecycleCommand(
				session,
				{ operation: "interrupt", childId: handleId },
				{ json: true },
			);
			const closed = await runAgentLifecycleCommand(
				session,
				{ operation: "close", childId: handleId },
				{ json: true },
			);
			const closedAgain = await runAgentLifecycleCommand(
				session,
				{ operation: "close", childId: handleId },
				{ json: true },
			);
			out.stop();
			expect(code).toBe(0);
			expect(again).toBe(0);
			expect(closed).toBe(0);
			expect(closedAgain).toBe(0);
			const lines = out
				.text()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(lines).toEqual([
				{ operation: "interrupt", childId: handleId, status: "interrupted" },
				{ operation: "interrupt", childId: handleId, status: "interrupted" },
				{ operation: "close", childId: handleId, status: "closed" },
				{ operation: "close", childId: handleId, status: "closed" },
			]);

			const err = captureWrites("stderr");
			const afterClose = await runAgentLifecycleCommand(
				session,
				{ operation: "send", childId: handleId, input: "no" },
				{ json: true },
			);
			err.stop();
			expect(afterClose).toBe(1);
			expect(err.text()).toMatch(/closed/i);
		} finally {
			session.dispose();
		}
	});

	it("rejects unknown child run ids for every operation with a non-zero exit", async () => {
		const { session } = await buildParentSession("agent-lifecycle-unknown-id");
		try {
			const commands = [
				{ operation: "wait", childId: "missing-run" },
				{ operation: "send", childId: "missing-run", input: "hello" },
				{ operation: "resume", childId: "missing-run" },
				{ operation: "interrupt", childId: "missing-run" },
				{ operation: "close", childId: "missing-run" },
			] as const;
			for (const command of commands) {
				const err = captureWrites("stderr");
				const out = captureWrites("stdout");
				const code = await runAgentLifecycleCommand(session, { ...command }, { json: true });
				out.stop();
				err.stop();
				expect(code, command.operation).toBe(1);
				expect(err.text(), command.operation).toMatch(/[Uu]nknown/);
				expect(out.text(), command.operation).toBe("");
			}
		} finally {
			session.dispose();
		}
	});
});
