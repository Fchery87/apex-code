import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { PROJECT_RESOURCES } from "../src/core/project-resources.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".apex-code", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".apex-code", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".apex-code", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".apex-code"), { recursive: true });
			writeFileSync(join(cwd, ".apex-code", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".apex-code"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});

describe("project resource registry", () => {
	let tempDir: string;
	let cwd: string;
	let originalHome: string | undefined;

	function configDir(): string {
		return join(cwd, CONFIG_DIR_NAME);
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
		originalHome = process.env.HOME;
		process.env.HOME = join(tempDir, "home");
		mkdirSync(process.env.HOME, { recursive: true });
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("gates every registry entry, so a new entry cannot skip the classifier", () => {
		for (const resource of PROJECT_RESOURCES) {
			rmSync(cwd, { recursive: true, force: true });
			mkdirSync(cwd, { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			const base = resource.scope === "config-dir" ? configDir() : cwd;
			const target = join(base, resource.name);
			mkdirSync(dirname(target), { recursive: true });
			if (resource.name.endsWith(".json") || resource.name.endsWith(".md")) {
				writeFileSync(
					target,
					resource.authority === "permission-scope"
						? '{"version":1,"rules":[{"toolName":"bash","behavior":"allow"}]}'
						: "{}",
				);
			} else {
				mkdirSync(target, { recursive: true });
			}

			expect(hasTrustRequiringProjectResources(cwd), `${resource.scope}/${resource.name} must require trust`).toBe(
				true,
			);
		}
	});

	it("requires trust for a project permission file that grants a rule", () => {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(
			join(configDir(), "permissions.json"),
			'{"version":1,"rules":[{"toolName":"bash","behavior":"allow"}]}',
		);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("requires trust for a project permission file that sets only a mode", () => {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(join(configDir(), "permissions.json"), '{"version":1,"rules":[],"mode":"bypassPermissions"}');
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("requires trust for a local permission file that grants a rule", () => {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(
			join(configDir(), "permissions.local.json"),
			'{"version":1,"rules":[{"toolName":"bash","behavior":"allow"}]}',
		);
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("requires trust for a project agent definition", () => {
		mkdirSync(join(configDir(), "agents"), { recursive: true });
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("requires trust for a root-scoped .mcp.json, which is not under the config directory", () => {
		writeFileSync(join(cwd, ".mcp.json"), '{"mcpServers":{}}');
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("stays silent for a permission file that confers no authority", () => {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(join(configDir(), "permissions.json"), "{}");
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);
	});

	it("requires trust for a permission file it cannot parse, failing closed", () => {
		mkdirSync(configDir(), { recursive: true });
		writeFileSync(join(configDir(), "permissions.json"), '{"version":1,"rules":"not-an-array"}');
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
	});

	it("keeps the ancestor .agents/skills walk and its user-level exclusion", () => {
		const nested = join(cwd, "packages", "inner");
		mkdirSync(nested, { recursive: true });
		expect(hasTrustRequiringProjectResources(nested)).toBe(false);

		mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
		expect(hasTrustRequiringProjectResources(nested)).toBe(true);

		rmSync(join(cwd, ".agents"), { recursive: true, force: true });
		mkdirSync(join(process.env.HOME as string, ".agents", "skills"), { recursive: true });
		expect(hasTrustRequiringProjectResources(process.env.HOME as string)).toBe(false);
	});
});
