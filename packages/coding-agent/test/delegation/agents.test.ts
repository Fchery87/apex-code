import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDefinitionResolver } from "../../src/core/delegation/agents.ts";

let scratch: string;
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "apex-agent-definitions-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function definition(dir: string, filename: string, content: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, filename), content);
}

const VALID = `---
name: scout
description: Find relevant code
tools:
  - read
model: test-model
---
You are a focused scout.`;

describe("agent definition discovery", () => {
	it("loads a valid user-scope markdown definition by default", async () => {
		const agentDir = join(scratch, "agent");
		await definition(join(agentDir, "agents"), "scout.md", VALID);
		const resolve = createAgentDefinitionResolver({ cwd: scratch, agentDir, isProjectTrusted: () => false });
		expect(resolve("scout")).toEqual({
			name: "scout",
			description: "Find relevant code",
			tools: ["read"],
			model: "test-model",
			systemPrompt: "You are a focused scout.",
		});
	});

	it("does not load project-scope definitions unless the project is trusted", async () => {
		const agentDir = join(scratch, "agent");
		await definition(join(scratch, ".apex-code", "agents"), "scout.md", VALID);
		const untrusted = createAgentDefinitionResolver({ cwd: scratch, agentDir, isProjectTrusted: () => false });
		expect(untrusted("scout")).toBeUndefined();
		const trusted = createAgentDefinitionResolver({ cwd: scratch, agentDir, isProjectTrusted: () => true });
		expect(trusted("scout")).toMatchObject({ name: "scout", tools: ["read"] });
	});

	it("skips malformed or incomplete files rather than partially applying them", async () => {
		const agentDir = join(scratch, "agent");
		const dir = join(agentDir, "agents");
		await definition(dir, "missing-tools.md", `---\nname: missing-tools\ndescription: nope\n---\nbody`);
		await definition(dir, "bad-tools.md", `---\nname: bad-tools\ndescription: nope\ntools: read\n---\nbody`);
		await definition(dir, "bad-yaml.md", `---\nname: [unterminated\n---\nbody`);
		const resolve = createAgentDefinitionResolver({ cwd: scratch, agentDir, isProjectTrusted: () => false });
		expect(resolve("missing-tools")).toBeUndefined();
		expect(resolve("bad-tools")).toBeUndefined();
		expect(resolve("bad-yaml")).toBeUndefined();
	});
});
