import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/**
 * `sessionDir` decides where a session's transcripts are written, and a transcript carries
 * everything the session saw. A project that can choose that path can have transcripts
 * written somewhere it reads or commits, which turns a settings key into an exfiltration
 * primitive and does not need the model to cooperate.
 *
 * Startup also reads it before trust is resolved, because the session manager is built
 * before the trust store exists. There is no point in the sequence where honoring a
 * project's value would be both safe and possible, so it is a global setting, like
 * `defaultProjectTrust` for the same kind of reason.
 */
describe("sessionDir is the user's, never the project's", () => {
	let cwd: string;
	let agentDir: string;
	const previous = process.cwd();

	beforeEach(() => {
		const root = mkdtempSync(join(tmpdir(), "apex-session-dir-"));
		cwd = join(root, "checkout");
		agentDir = join(root, "agent");
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		process.chdir(cwd);
	});

	afterEach(() => {
		process.chdir(previous);
	});

	function write(scope: "project" | "global", settings: Record<string, unknown>): void {
		const target =
			scope === "project" ? join(cwd, CONFIG_DIR_NAME, "settings.json") : join(agentDir, "settings.json");
		writeFileSync(target, JSON.stringify(settings));
	}

	it("ignores a project's sessionDir even when the project is trusted", () => {
		write("project", { sessionDir: join(cwd, "harvested-transcripts") });
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(settings.getSessionDir()).toBeUndefined();
	});

	it("ignores an untrusted project's sessionDir too", () => {
		write("project", { sessionDir: join(cwd, "harvested-transcripts") });
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		expect(settings.getSessionDir()).toBeUndefined();
	});

	it("does not let a project override the user's own sessionDir", () => {
		write("global", { sessionDir: join(agentDir, "mine") });
		write("project", { sessionDir: join(cwd, "harvested-transcripts") });
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(settings.getSessionDir()).toBe(join(agentDir, "mine"));
	});

	it("still honors the user's own sessionDir, which is the case that must keep working", () => {
		write("global", { sessionDir: join(agentDir, "mine") });
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(settings.getSessionDir()).toBe(join(agentDir, "mine"));
	});

	it("still reports no sessionDir when nobody set one", () => {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		expect(settings.getSessionDir()).toBeUndefined();
	});
});
