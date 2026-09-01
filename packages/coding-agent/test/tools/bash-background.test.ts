import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createBackgroundShellRegistry } from "../../src/core/tools/background-shell.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function newCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-bg-bash-"));
	directories.push(cwd);
	return cwd;
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!(await condition())) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for background condition");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

type BashDefinition = ReturnType<typeof createBashToolDefinition>;
type BashExecuteResult = Awaited<ReturnType<BashDefinition["execute"]>>;

/** ApexToolDefinition.execute declares all five parameters; keep call sites short. The local shell path never reads ctx. */
function run(definition: BashDefinition, id: string, input: unknown): Promise<BashExecuteResult> {
	return definition.execute(
		id,
		input as never,
		undefined,
		undefined,
		undefined as never,
	) as Promise<BashExecuteResult>;
}

function textOf(result: BashExecuteResult): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

describe.skipIf(process.platform === "win32")("bash background execution", () => {
	it("returns a handle immediately and retrieves output after exit", async () => {
		const cwd = newCwd();
		const definition = createBashToolDefinition(cwd);

		const launch = await run(definition, "t1", { command: "echo background-done", background: true });
		const handle = /handle (\S+)/.exec(textOf(launch))?.[1];
		if (!handle) throw new Error("launch did not return a handle");
		expect(handle).toBeTruthy();

		let text = "";
		await until(async () => {
			text = textOf(await run(definition, "t2", { handle }));
			return !/running/.test(text);
		});
		expect(text).toContain("background-done");
		expect(text).toContain("exited (code 0)");
	});

	it("kills a running command through the handle", async () => {
		const cwd = newCwd();
		const definition = createBashToolDefinition(cwd);

		const launch = await run(definition, "t1", { command: "sleep 30", background: true });
		const handle = /handle (\S+)/.exec(textOf(launch))?.[1];
		if (!handle) throw new Error("launch did not return a handle");

		const kill = await run(definition, "t2", { handle, kill: true });
		expect(textOf(kill)).toContain("kill signal");

		await until(async () => {
			const retrieved = await run(definition, "t3", { handle });
			return !/running/.test(textOf(retrieved));
		});
	});

	it("names the limitation for a command run against an unknown handle", async () => {
		const cwd = newCwd();
		const definition = createBashToolDefinition(cwd);

		await expect(run(definition, "t1", { handle: "missing" })).rejects.toThrow(/Unknown background handle/);
	});

	it("records the originating command in evidence for retrieve calls", async () => {
		const cwd = newCwd();
		const registry = createBackgroundShellRegistry();
		const definition = createBashToolDefinition(cwd, { backgroundRegistry: registry });

		const launch = await run(definition, "t1", { command: "echo evidence-target", background: true });
		const handle = /handle (\S+)/.exec(textOf(launch))?.[1];
		if (!handle) throw new Error("launch did not return a handle");

		const records = definition.contract.evidence.capture(
			{ handle } as never,
			{
				details: { execution: { cwd, exitCode: 0 } },
			} as never,
		);
		expect(records).toEqual([
			{ kind: "command", command: expect.stringContaining("evidence-target"), cwd, exitCode: 0 },
		]);
	});

	it("tells the model a foreground rerun gets the escalation offer on a sandbox refusal", async () => {
		const cwd = newCwd();
		const definition = createBashToolDefinition(cwd);

		const launch = await run(definition, "t1", {
			command: `echo "Operation not permitted"; exit 1`,
			background: true,
		});
		const handle = /handle (\S+)/.exec(textOf(launch))?.[1];
		if (!handle) throw new Error("launch did not return a handle");

		let text = "";
		await until(async () => {
			text = textOf(await run(definition, "t2", { handle }));
			return !/running/.test(text);
		});
		expect(text).toContain("Rerun this command in the foreground");
	});
});

describe("background shell session wiring", () => {
	it("disposes the registry when the session disposes", async () => {
		const cwd = newCwd();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeSettings(agentDir);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"));
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		const registry = createBackgroundShellRegistry();
		let disposed = false;
		const spy = Object.assign(registry, {
			dispose: () => {
				disposed = true;
			},
		});

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			backgroundShellRegistry: spy,
		});
		expect(disposed).toBe(false);
		created.session.dispose();
		expect(disposed).toBe(true);
	});
});

function writeSettings(agentDir: string): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
}
