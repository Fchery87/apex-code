import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionRule } from "../../src/core/permissions/rules.ts";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { scratchDir } from "../suite/scratch.ts";

const dirs: string[] = [];
afterEach(async () => {
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

describe("read boundary: reads outside the workspace ask", () => {
	it("asks before read reaches a file outside the workspace", async () => {
		const cwd = await scratchDir("apex-rb-");
		const outside = await scratchDir("apex-rb-outside-");
		dirs.push(cwd, outside);
		await writeFile(join(outside, "notes.txt"), "outside");

		const decision = await decide(createReadToolDefinition(cwd), { path: join(outside, "notes.txt") });
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/requires approval/);
	});

	it("allows read of a file inside the workspace without a prompt", async () => {
		const cwd = await scratchDir("apex-rb-");
		dirs.push(cwd);
		await writeFile(join(cwd, "inside.txt"), "inside");

		const decision = await decide(createReadToolDefinition(cwd), { path: "inside.txt" });
		expect(decision.block).toBe(false);
	});

	it("asks for grep and ls targets outside the workspace", async () => {
		const cwd = await scratchDir("apex-rb-");
		const outside = await scratchDir("apex-rb-outside-");
		dirs.push(cwd, outside);

		const grep = await decide(createGrepToolDefinition(cwd), { pattern: "x", path: outside });
		const ls = await decide(createLsToolDefinition(cwd), { path: outside });
		expect(grep.block).toBe(true);
		expect(ls.block).toBe(true);
	});

	it("treats a symlink inside the workspace that points outside as outside", async () => {
		const cwd = await scratchDir("apex-rb-");
		const outside = await scratchDir("apex-rb-outside-");
		dirs.push(cwd, outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		const { symlink } = await import("node:fs/promises");
		await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"));

		const decision = await decide(createReadToolDefinition(cwd), { path: "link.txt" });
		expect(decision.block).toBe(true);
	});

	it("a directory name with glob characters grants only that literal directory", async () => {
		const cwd = await scratchDir("apex-rb-");
		const outside = await scratchDir("apex-rb-outside-");
		dirs.push(cwd, outside);
		const literal = join(outside, "a[1]*");
		const lookalike = join(outside, "a1x");
		await mkdir(literal, { recursive: true });
		await mkdir(lookalike, { recursive: true });
		await writeFile(join(literal, "x.ts"), "x");
		await writeFile(join(lookalike, "y.ts"), "y");

		const definition = createReadToolDefinition(cwd);
		const saved = definition.contract.permission.ruleForCall({ path: join(literal, "x.ts") } as never);
		const rule: PermissionRule = {
			source: "session",
			behavior: "allow",
			toolName: "read",
			ruleContent: saved as string,
		};
		const inside = await decide(definition, { path: join(literal, "x.ts") }, [rule]);
		const other = await decide(definition, { path: join(lookalike, "y.ts") }, [rule]);
		expect(inside.block).toBe(false);
		expect(other.block).toBe(true);
	});

	it("an always-allow rule saved for one outside file grants its sibling files", async () => {
		const cwd = await scratchDir("apex-rb-");
		const outside = await scratchDir("apex-rb-outside-");
		dirs.push(cwd, outside);
		await mkdir(join(outside, "src"), { recursive: true });
		await writeFile(join(outside, "src", "a.ts"), "a");
		await writeFile(join(outside, "src", "b.ts"), "b");

		const definition = createReadToolDefinition(cwd);
		const saved = definition.contract.permission.ruleForCall({ path: join(outside, "src", "a.ts") } as never);
		expect(saved).not.toBeNull();
		const rule: PermissionRule = {
			source: "session",
			behavior: "allow",
			toolName: "read",
			ruleContent: saved as string,
		};
		const sibling = await decide(definition, { path: join(outside, "src", "b.ts") }, [rule]);
		const unrelated = await decide(definition, { path: join(outside, "other.ts") }, [rule]);
		expect(sibling.block).toBe(false);
		expect(unrelated.block).toBe(true);
		expect(dirname(join(outside, "src", "a.ts"))).toBe(join(outside, "src"));
	});
});
