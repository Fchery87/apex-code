import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionRule } from "../../src/core/permissions/rules.ts";
import { createLsToolDefinition } from "../../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { scratchDir } from "../suite/scratch.ts";

const dirs: string[] = [];
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(async () => {
	const home = await scratchDir("apex-sp-home-");
	dirs.push(home);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

afterEach(async () => {
	process.env.HOME = savedHome.HOME;
	process.env.USERPROFILE = savedHome.USERPROFILE;
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const emptyStore = {
	snapshot: async () => ({ rules: [], modesBySource: new Map(), errors: [] }),
	apply: async () => {},
};

async function decide(
	definition: { name: string; contract: unknown },
	input: Record<string, unknown>,
	rules: PermissionRule[] = [],
) {
	return evaluateToolCall(definition.name, input, {
		getContract: () => definition.contract as never,
		store: {
			...emptyStore,
			snapshot: async () => ({ rules: rules as never, modesBySource: new Map(), errors: [] }),
		},
		getMode: () => "default",
	});
}

const blanketRead: PermissionRule = { source: "user", behavior: "allow", toolName: "read" };

describe("protected targets: home-directory credentials", () => {
	it("refuses a read of a file under ~/.ssh even under a blanket user allow", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		const ssh = join(process.env.HOME as string, ".ssh");
		await mkdir(ssh, { recursive: true });
		await writeFile(join(ssh, "id_rsa"), "key");

		const decision = await decide(createReadToolDefinition(cwd), { path: join(ssh, "id_rsa") }, [blanketRead]);
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/No rule can grant this path/);
	});

	it("a policy allow is the only rule that grants a protected target", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		const ssh = join(process.env.HOME as string, ".ssh");
		await mkdir(ssh, { recursive: true });
		await writeFile(join(ssh, "id_rsa"), "key");

		const policy: PermissionRule = { source: "policy", behavior: "allow", toolName: "read", ruleContent: "**" };
		const decision = await decide(createReadToolDefinition(cwd), { path: join(ssh, "id_rsa") }, [policy]);
		expect(decision.block).toBe(false);
	});

	it("refuses a listing of the home directory, because it contains ~/.ssh", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		const decision = await decide(createLsToolDefinition(cwd), { path: process.env.HOME as string }, [
			{ source: "user", behavior: "allow", toolName: "ls" },
		]);
		expect(decision.block).toBe(true);
	});

	it("refuses ~/.netrc and ~/.docker/config.json", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		const home = process.env.HOME as string;
		await mkdir(join(home, ".docker"), { recursive: true });
		await writeFile(join(home, ".netrc"), "machine x");
		await writeFile(join(home, ".docker", "config.json"), "{}");
		const netrc = await decide(createReadToolDefinition(cwd), { path: join(home, ".netrc") }, [blanketRead]);
		const docker = await decide(createReadToolDefinition(cwd), { path: join(home, ".docker", "config.json") }, [
			blanketRead,
		]);
		expect(netrc.block).toBe(true);
		expect(docker.block).toBe(true);
	});

	it("leaves an ordinary home file readable", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		const home = process.env.HOME as string;
		await writeFile(join(home, ".gitconfig"), "[user]");
		const decision = await decide(createReadToolDefinition(cwd), { path: join(home, ".gitconfig") }, [blanketRead]);
		expect(decision.block).toBe(false);
	});
});

describe("sensitive paths: .env files ask, and only a rule naming the file grants them", () => {
	it("asks for .env in the workspace with no rule", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		await writeFile(join(cwd, ".env"), "TOKEN=x");
		const decision = await decide(createReadToolDefinition(cwd), { path: ".env" });
		expect(decision.block).toBe(true);
	});

	it("a blanket allow does not grant .env", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		await writeFile(join(cwd, ".env"), "TOKEN=x");
		const decision = await decide(createReadToolDefinition(cwd), { path: ".env" }, [blanketRead]);
		expect(decision.block).toBe(true);
	});

	it("a directory rule covering .env does not grant it", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		await writeFile(join(cwd, ".env"), "TOKEN=x");
		const dirRule: PermissionRule = { source: "user", behavior: "allow", toolName: "read", ruleContent: "**" };
		const decision = await decide(createReadToolDefinition(cwd), { path: ".env" }, [dirRule]);
		expect(decision.block).toBe(true);
	});

	it("a rule naming the basename grants .env", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		await writeFile(join(cwd, ".env"), "TOKEN=x");
		const named: PermissionRule = { source: "user", behavior: "allow", toolName: "read", ruleContent: "**/.env" };
		const decision = await decide(createReadToolDefinition(cwd), { path: ".env" }, [named]);
		expect(decision.block).toBe(false);
	});

	it("template files stay ordinary", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		await writeFile(join(cwd, ".env.example"), "TOKEN=");
		const decision = await decide(createReadToolDefinition(cwd), { path: ".env.example" });
		expect(decision.block).toBe(false);
	});

	it("a suffixed env file such as .env.production asks", async () => {
		const cwd = await scratchDir("apex-sp-cwd-");
		dirs.push(cwd);
		await writeFile(join(cwd, ".env.production"), "TOKEN=x");
		const decision = await decide(createReadToolDefinition(cwd), { path: ".env.production" });
		expect(decision.block).toBe(true);
	});
});
