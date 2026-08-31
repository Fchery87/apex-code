import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

/** A command hook that blocks `bash` calls and allows everything else, decided from the stdin payload. */
function blockingHookScript(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-hook-wiring-"));
	directories.push(directory);
	const file = join(directory, "hook.mjs");
	writeFileSync(
		file,
		`let raw="";process.stdin.on("data",(c)=>(raw+=c));process.stdin.on("end",()=>{const p=JSON.parse(raw);process.stdout.write(JSON.stringify(p.toolName==="bash"?{decision:"block",reason:"denied by policy hook"}:{decision:"allow"}));});`,
	);
	return `node "${file}"`;
}

async function session(hooks: Record<string, unknown>) {
	const cwd = mkdtempSync(join(tmpdir(), "apex-hook-session-"));
	directories.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settings = Object.keys(hooks).length > 0 ? { hooks } : {};
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	const created = await createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	return created.session;
}

type BeforeToolCall = (input: unknown) => Promise<unknown>;

function beforeToolCallOf(session: unknown): BeforeToolCall | undefined {
	return (session as { agent: { beforeToolCall?: BeforeToolCall } }).agent.beforeToolCall;
}

describe("declarative hook session wiring", () => {
	it("blocks a matching tool call through the beforeToolCall seam", async () => {
		const agentSession = await session({
			tool_call: [{ type: "command", command: blockingHookScript(), matcher: "bash" }],
		});

		const result = await beforeToolCallOf(agentSession)?.({
			toolCall: { name: "bash", id: "t1" },
			args: { command: "git push" },
		});

		expect(result).toEqual({ block: true, reason: "denied by policy hook" });
		agentSession.dispose();
	});

	it("falls through when the hook does not match, leaving the gate as the last check", async () => {
		const agentSession = await session({
			tool_call: [{ type: "command", command: blockingHookScript(), matcher: "read" }],
		});

		const result = await beforeToolCallOf(agentSession)?.({
			toolCall: { name: "bash", id: "t1" },
			args: { command: "git push" },
		});

		expect(result).toBeUndefined();
		agentSession.dispose();
	});

	it("wires nothing when the hooks key is absent", async () => {
		const agentSession = await session({});

		const result = await beforeToolCallOf(agentSession)?.({
			toolCall: { name: "bash", id: "t1" },
			args: { command: "git push" },
		});

		expect(result).toBeUndefined();
		agentSession.dispose();
	});
});
