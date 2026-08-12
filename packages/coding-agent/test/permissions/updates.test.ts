import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilePermissionRuleStore, type StoredPermissionRule } from "../../src/core/permissions/store.ts";

const sharedTempDir = join(tmpdir(), `pi-permission-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

function rule(overrides: Partial<StoredPermissionRule> = {}): StoredPermissionRule {
	return { toolName: "read", behavior: "allow", ruleContent: "src/**", ...overrides };
}

function createStore(name: string, policyPath?: string) {
	const cwd = join(sharedTempDir, name, "project");
	const agentDir = join(sharedTempDir, name, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return new FilePermissionRuleStore({ cwd, agentDir, policyPath: policyPath ?? join(sharedTempDir, name, "missing-policy.json") });
}

describe("FilePermissionRuleStore", () => {
	it("round-trips addRules to its stated destination, re-read by a fresh store instance", async () => {
		const cwd = join(sharedTempDir, "roundtrip-add", "project");
		const agentDir = join(sharedTempDir, "roundtrip-add", "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const policyPath = join(sharedTempDir, "roundtrip-add", "missing-policy.json");

		const first = new FilePermissionRuleStore({ cwd, agentDir, policyPath });
		await first.apply({ type: "addRules", destination: "project", rules: [rule()] });

		const second = new FilePermissionRuleStore({ cwd, agentDir, policyPath });
		const { rules } = await second.snapshot();
		expect(rules).toEqual([{ ...rule(), source: "project" }]);
	});

	it("round-trips replaceRules, discarding whatever was there before", async () => {
		const store = createStore("roundtrip-replace");
		await store.apply({ type: "addRules", destination: "user", rules: [rule({ toolName: "write" })] });
		await store.apply({ type: "replaceRules", destination: "user", rules: [rule({ toolName: "edit" })] });

		const { rules } = await store.snapshot();
		expect(rules).toEqual([{ ...rule({ toolName: "edit" }), source: "user" }]);
	});

	it("round-trips removeRules, matching by toolName and ruleContent only", async () => {
		const store = createStore("roundtrip-remove");
		await store.apply({
			type: "addRules",
			destination: "local",
			rules: [rule({ toolName: "read", ruleContent: "a" }), rule({ toolName: "read", ruleContent: "b" })],
		});
		await store.apply({ type: "removeRules", destination: "local", matching: [{ toolName: "read", ruleContent: "a" }] });

		const { rules } = await store.snapshot();
		expect(rules).toEqual([{ ...rule({ toolName: "read", ruleContent: "b" }), source: "local" }]);
	});

	it("round-trips setMode to its stated destination", async () => {
		const store = createStore("roundtrip-mode");
		await store.apply({ type: "setMode", destination: "project", mode: "acceptEdits" });

		const { modesBySource } = await store.snapshot();
		expect(modesBySource.get("project")).toBe("acceptEdits");
		expect(modesBySource.has("local")).toBe(false);
	});

	it("never writes a session-destination update to disk", async () => {
		const cwd = join(sharedTempDir, "session-runtime-only", "project");
		const agentDir = join(sharedTempDir, "session-runtime-only", "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const store = new FilePermissionRuleStore({
			cwd,
			agentDir,
			policyPath: join(sharedTempDir, "session-runtime-only", "missing-policy.json"),
		});

		await store.apply({ type: "addRules", destination: "session", rules: [rule()] });
		await store.apply({ type: "setMode", destination: "session", mode: "bypassPermissions" });

		expect(existsSync(join(cwd, ".apex-code", "permissions.json"))).toBe(false);
		expect(existsSync(join(cwd, ".apex-code", "permissions.local.json"))).toBe(false);
		expect(existsSync(join(agentDir, "permissions.json"))).toBe(false);

		const { rules, modesBySource } = await store.snapshot();
		expect(rules).toEqual([{ ...rule(), source: "session" }]);
		expect(modesBySource.get("session")).toBe("bypassPermissions");

		// And it does not survive a fresh store instance over the same paths — runtime-only.
		const reopened = new FilePermissionRuleStore({
			cwd,
			agentDir,
			policyPath: join(sharedTempDir, "session-runtime-only", "missing-policy.json"),
		});
		const reopenedSnapshot = await reopened.snapshot();
		expect(reopenedSnapshot.rules).toEqual([]);
	});

	it("never writes a command-destination update to disk either", async () => {
		const store = createStore("command-runtime-only");
		await store.apply({ type: "addRules", destination: "command", rules: [rule()] });
		const { rules } = await store.snapshot();
		expect(rules).toEqual([{ ...rule(), source: "command" }]);
	});

	it("writing to project does not disturb local or user", async () => {
		const store = createStore("isolation");
		await store.apply({ type: "addRules", destination: "local", rules: [rule({ toolName: "local-tool" })] });
		await store.apply({ type: "addRules", destination: "user", rules: [rule({ toolName: "user-tool" })] });
		await store.apply({ type: "addRules", destination: "project", rules: [rule({ toolName: "project-tool" })] });

		const { rules } = await store.snapshot();
		const bySource = Object.fromEntries(rules.map((r) => [r.source, r.toolName]));
		expect(bySource.local).toBe("local-tool");
		expect(bySource.user).toBe("user-tool");
		expect(bySource.project).toBe("project-tool");
	});

	it("surfaces a malformed rules file as an error without discarding the other sources", async () => {
		const cwd = join(sharedTempDir, "malformed", "project");
		const agentDir = join(sharedTempDir, "malformed", "agent");
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, ".apex-code", "permissions.local.json"), "not valid json{{{", "utf-8");
		const store = new FilePermissionRuleStore({
			cwd,
			agentDir,
			policyPath: join(sharedTempDir, "malformed", "missing-policy.json"),
		});
		await store.apply({ type: "addRules", destination: "user", rules: [rule({ toolName: "user-tool" })] });

		const { rules, errors } = await store.snapshot();
		expect(errors).toHaveLength(1);
		expect(errors[0].source).toBe("local");
		// The good source (user) still comes through.
		expect(rules.some((r) => r.toolName === "user-tool" && r.source === "user")).toBe(true);
	});

	it("treats a missing or absent policy file as empty, without an error", async () => {
		const store = createStore("no-policy");
		const { rules, errors } = await store.snapshot();
		expect(rules).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("reads a real policy file read-only, tagging its rules with source policy", async () => {
		const policyPath = join(sharedTempDir, "real-policy.json");
		writeFileSync(
			policyPath,
			JSON.stringify({ version: 1, rules: [rule({ toolName: "policy-tool" })] }),
			"utf-8",
		);
		const store = createStore("with-policy", policyPath);
		const { rules } = await store.snapshot();
		expect(rules).toEqual([{ ...rule({ toolName: "policy-tool" }), source: "policy" }]);
	});
});
