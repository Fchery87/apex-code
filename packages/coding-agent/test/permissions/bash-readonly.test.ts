import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { scratchDir } from "../suite/scratch.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const store = {
	snapshot: async () => ({ rules: [], modesBySource: new Map(), errors: [] }),
	apply: async () => {},
};

async function asks(command: string): Promise<boolean> {
	const cwd = await scratchDir("apex-bash-ro-");
	dirs.push(cwd);
	const definition = createBashToolDefinition(cwd);
	const decision = await evaluateToolCall(
		"bash",
		{ command },
		{
			getContract: () => definition.contract as never,
			store,
			getMode: () => "default",
		},
	);
	return decision.block;
}

describe("bash allow-list for commands that cannot read outside the repository (HR.21)", () => {
	it.each([
		"pwd",
		"git status",
		"git status --short",
		"git log --oneline",
		"git log --oneline HEAD~3",
		"git diff --stat",
		"git diff src/x.ts",
		"git branch -a",
		"git branch --show-current",
		"git show --stat HEAD",
		"git rev-parse --abbrev-ref HEAD",
		"node --version",
	])("runs %s without a prompt", async (command) => {
		expect(await asks(command)).toBe(false);
	});

	it.each([
		"git log && rm x",
		"git diff /dev/null /etc/passwd",
		"git diff ../../outside.txt",
		"git -c core.fsmonitor=evil status",
		"git branch -D main",
		"git branch newbranch",
		"git diff --output=out.txt",
		"git diff --no-index a b",
		"git log -- secret.txt",
		"./evil --version",
	])("asks for %s", async (command) => {
		expect(await asks(command)).toBe(true);
	});
});
