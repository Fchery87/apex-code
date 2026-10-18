import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDefinitionResolver } from "../../src/core/delegation/agents.ts";

let scratch: string;
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "apex-builtin-agents-"));
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

function resolverFor(agentDir: string, trusted = false) {
	return createAgentDefinitionResolver({ cwd: scratch, agentDir, isProjectTrusted: () => trusted });
}

describe("built-in agent types (HR.9)", () => {
	it("resolves explore to read-only search tools with no bash", () => {
		const explore = resolverFor(join(scratch, "empty-agent"))("explore");
		expect(explore?.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(explore?.tools).not.toContain("bash");
	});

	it("resolves general to the default tools, never delegate", () => {
		const general = resolverFor(join(scratch, "empty-agent"))("general");
		expect(general?.tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		expect(general?.tools).not.toContain("delegate");
	});

	it("keeps todo_write opt-in for built-in children too (HR.15)", () => {
		const general = resolverFor(join(scratch, "empty-agent"))("general");
		expect(general?.tools).not.toContain("todo_write");
	});

	it("gives both built-ins a description and a system prompt", () => {
		const resolve = resolverFor(join(scratch, "empty-agent"));
		for (const name of ["explore", "general"]) {
			const definition = resolve(name);
			expect(definition?.description.length).toBeGreaterThan(0);
			expect(definition?.systemPrompt.length).toBeGreaterThan(0);
		}
	});

	it("a user definition with the same name replaces the built-in", async () => {
		const agentDir = join(scratch, "agent");
		await mkdir(join(agentDir, "agents"), { recursive: true });
		await writeFile(
			join(agentDir, "agents", "explore.md"),
			"---\nname: explore\ndescription: mine\ntools:\n  - read\n---\nMine.",
		);
		const explore = resolverFor(agentDir)("explore");
		expect(explore?.description).toBe("mine");
		expect(explore?.tools).toEqual(["read"]);
	});

	it("an unknown agent type still resolves to nothing", () => {
		expect(resolverFor(join(scratch, "empty-agent"))("nonexistent")).toBeUndefined();
	});

	it("lists the built-in and discovered names so the model can be told what exists", () => {
		const resolver = resolverFor(join(scratch, "empty-agent"));
		expect(resolver.list?.().map((entry) => entry.name)).toEqual(expect.arrayContaining(["explore", "general"]));
	});
});
