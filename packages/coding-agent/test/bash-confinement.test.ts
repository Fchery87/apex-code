import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { confineBash } from "../src/core/tools/bash-confinement.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

describe("bash confinement", () => {
	it("does nothing when the setting is off", () => {
		const result = confineBash({ enabled: false, command: "echo hi", cwd: "/work", helperPath: undefined });
		expect(result).toEqual({ run: true, command: "echo hi" });
	});

	it("refuses when the setting is on and the helper is missing", () => {
		const result = confineBash({ enabled: true, command: "echo hi", cwd: "/work", helperPath: undefined });
		expect(result.run).toBe(false);
		expect(result.refusal).toMatch(process.platform === "win32" ? /not available on Windows/ : /bwrap/);
	});

	it("does not run the command when bash confinement is on and bwrap is absent", async () => {
		const previous = process.env.PATH;
		process.env.PATH = "";
		let ran = false;
		try {
			const tool = createBashToolDefinition("/tmp", {
				confinement: true,
				operations: {
					exec: async () => {
						ran = true;
						return { exitCode: 0 };
					},
				},
			});
			const result = await tool.execute("call-1", { command: "echo hi" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
			} as never);
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).toMatch(process.platform === "win32" ? /not available on Windows/ : /bwrap/);
			expect(ran).toBe(false);
		} finally {
			process.env.PATH = previous;
		}
	});

	it.skipIf(process.platform === "win32")("runs the original command when bwrap is on PATH", async () => {
		const root = mkdtempSync(join(tmpdir(), "apex-confinement-helper-"));
		directories.push(root);
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "bwrap"), "");
		const previous = process.env.PATH;
		process.env.PATH = bin;
		let ranCommand = "";
		try {
			const tool = createBashToolDefinition(root, {
				confinement: true,
				operations: {
					exec: async (command, _cwd, options) => {
						ranCommand = options.argv ? options.argv.join(" ") : command;
						return { exitCode: 0 };
					},
				},
			});
			await tool.execute("call-1", { command: "echo hi" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
			} as never);
			expect(ranCommand.startsWith(join(bin, "bwrap"))).toBe(true);
			expect(ranCommand).toContain("echo hi");
		} finally {
			process.env.PATH = previous;
		}
	});

	it("stays off unless the user file turns it on, and a project file cannot", () => {
		const root = mkdtempSync(join(tmpdir(), "apex-confinement-settings-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ bashConfinement: "off" }));
		writeFileSync(join(projectDir, ".apex-code", "settings.json"), JSON.stringify({ bashConfinement: "on" }));
		const fromProject = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		expect(fromProject.getBashConfinement()).toBe(false);

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ bashConfinement: "on" }));
		writeFileSync(join(projectDir, ".apex-code", "settings.json"), JSON.stringify({ bashConfinement: "off" }));
		const fromUser = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
		expect(fromUser.getBashConfinement()).toBe(true);
	});
});
