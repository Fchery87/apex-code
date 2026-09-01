import { spawnSync } from "node:child_process";
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

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A workspace that is a real repository, with global settings the session will read. */
function workspace(settings: Record<string, unknown>): { cwd: string; agentDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), "apex-checkpoint-wiring-"));
	directories.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

	git(cwd, "init", "-q", ".");
	git(cwd, "config", "user.email", "fixture@example.com");
	git(cwd, "config", "user.name", "fixture");
	writeFileSync(join(cwd, "tracked.txt"), "v1\n");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", "base");
	return { cwd, agentDir };
}

async function session(settings: Record<string, unknown>, sessionId: string) {
	const { cwd, agentDir } = workspace(settings);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, join(agentDir, "sessions"), { id: sessionId });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	const created = await createAgentSession({
		cwd,
		agentDir,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	return { cwd, session: created.session };
}

function refs(cwd: string): string[] {
	return git(cwd, "for-each-ref", "--format=%(refname)", "refs/apex-code/").split("\n").filter(Boolean);
}

describe("checkpoint session wiring", () => {
	it("carries the settings key through the SDK into a capturing session", async () => {
		const { cwd, session: agentSession } = await session({ checkpoints: { enabled: true } }, "wiring-on");
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		await agentSession.checkpoints.capture("entry-1");

		expect(refs(cwd)).toEqual(["refs/apex-code/checkpoints/wiring-on/entry-1"]);
		agentSession.dispose();
	});

	it("captures by default when the settings key is absent", async () => {
		const { cwd, session: agentSession } = await session({}, "wiring-default");
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		expect((await agentSession.checkpoints.capture("entry-1"))?.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(refs(cwd)).toEqual(["refs/apex-code/checkpoints/wiring-default/entry-1"]);
		agentSession.dispose();
	});

	it("captures nothing when checkpoints are explicitly disabled", async () => {
		const { cwd, session: agentSession } = await session({ checkpoints: { enabled: false } }, "wiring-off");
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		expect(await agentSession.checkpoints.capture("entry-1")).toBeUndefined();
		expect(refs(cwd)).toEqual([]);
		agentSession.dispose();
	});

	it("keys refs to the session id the session manager reports", async () => {
		const { cwd, session: agentSession } = await session({ checkpoints: { enabled: true } }, "named-session");
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		// The ref namespace is what keeps two concurrent sessions in one workspace from
		// pruning each other, so it has to be the real session id rather than anything
		// this layer invents.
		await agentSession.checkpoints.capture("entry-1");

		expect(refs(cwd)).toEqual(["refs/apex-code/checkpoints/named-session/entry-1"]);
		agentSession.dispose();
	});
});
