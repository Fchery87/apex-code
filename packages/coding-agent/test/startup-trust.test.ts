import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRuntime } from "../src/core/mcp/runtime.ts";
import { FilePermissionRuleStore } from "../src/core/permissions/store.ts";

const scratch: string[] = [];
function workspace(): string {
	const path = mkdtempSync(join(tmpdir(), "apex-startup-trust-"));
	scratch.push(path);
	return path;
}
afterEach(() => {
	for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
const scope = (mode: string) => JSON.stringify({ version: 1, rules: [{ toolName: "bash", behavior: "allow" }], mode });

describe("startup trust public loaders", () => {
	it("does not activate untrusted project permission grants or modes", async () => {
		const cwd = workspace();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		writeFileSync(join(cwd, ".apex-code", "permissions.json"), scope("bypassPermissions"));
		writeFileSync(join(cwd, ".apex-code", "permissions.local.json"), scope("acceptEdits"));
		const snapshot = await new FilePermissionRuleStore({
			cwd,
			agentDir,
			projectTrusted: false,
			policyPath: join(cwd, "policy"),
		}).snapshot();
		expect(snapshot.rules.filter((rule) => rule.source === "project" || rule.source === "local")).toEqual([]);
		expect(snapshot.modesBySource.has("project")).toBe(false);
		expect(snapshot.modesBySource.has("local")).toBe(false);
	});

	it("activates trusted project permission controls", async () => {
		const cwd = workspace();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		writeFileSync(join(cwd, ".apex-code", "permissions.json"), scope("acceptEdits"));
		const snapshot = await new FilePermissionRuleStore({
			cwd,
			agentDir,
			projectTrusted: true,
			policyPath: join(cwd, "policy"),
		}).snapshot();
		expect(snapshot.rules).toContainEqual({ source: "project", toolName: "bash", behavior: "allow" });
		expect(snapshot.modesBySource.get("project")).toBe("acceptEdits");
	});

	it("does not create or warm untrusted eager project MCP", async () => {
		const cwd = workspace();
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { bad: { command: "bad", lifecycle: "eager" } } }),
		);
		const connector = vi.fn();
		expect(createMcpRuntime(cwd, connector, { projectTrusted: false })).toBeUndefined();
		expect(connector).not.toHaveBeenCalled();
	});

	it("freezes authorization at construction against file and symlink replacement", async () => {
		const cwd = workspace();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		const permissionPath = join(cwd, ".apex-code", "permissions.json");
		writeFileSync(permissionPath, scope("acceptEdits"));
		const store = new FilePermissionRuleStore({
			cwd,
			agentDir,
			projectTrusted: true,
			policyPath: join(cwd, "policy"),
		});
		const before = await store.snapshot();
		writeFileSync(permissionPath, scope("bypassPermissions"));
		expect(await store.snapshot()).toEqual(before);
		rmSync(permissionPath);
		const attacker = join(cwd, "attacker.json");
		writeFileSync(attacker, scope("bypassPermissions"));
		symlinkSync(attacker, permissionPath);
		expect(await store.snapshot()).toEqual(before);
	});
});
