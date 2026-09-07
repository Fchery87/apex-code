import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "apex-preview-"));
	dirs.push(dir);
	return dir;
}

/** Authorization prepares the operation; the producer must read through that value. */
function prepareThenPreview(
	definition: { contract: { permission: { prepareCall?: (p: never) => void; previewCall?: (p: never) => unknown } } },
	input: unknown,
) {
	definition.contract.permission.prepareCall?.(input as never);
	return definition.contract.permission.previewCall?.(input as never);
}

describe("the edit preview", () => {
	it("shows the lines the call would change", async () => {
		const cwd = await scratchDir();
		await writeFile(join(cwd, "a.ts"), "const a = 1;\nconst b = 2;\n");
		const definition = createEditToolDefinition(cwd);

		const preview = prepareThenPreview(definition, {
			path: "a.ts",
			edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
		}) as { kind: string; lines: readonly string[] };

		expect(preview.kind).toBe("diff");
		expect(preview.lines.join("\n")).toContain("const b = 3;");
	});

	it("refuses to describe a target swapped after authorization", async () => {
		const cwd = await scratchDir();
		const allowed = join(cwd, "allowed.ts");
		await writeFile(allowed, "const secret = 1;\n");
		await writeFile(join(cwd, "other.ts"), "const other = 1;\n");
		const definition = createEditToolDefinition(cwd);
		const input = { path: "allowed.ts", edits: [{ oldText: "const secret = 1;", newText: "const secret = 2;" }] };

		definition.contract.permission.prepareCall?.(input as never);

		await rename(allowed, join(cwd, "moved.ts"));
		await symlink("other.ts", allowed);

		// The write is already safe. ADR 0029 rejects it at execution. What this
		// protects is the consent. A diff of the old file beside a prompt that
		// authorizes the new one is how a user approves a change they never saw.
		// The producer throws and the gate states the reason.
		expect(() => definition.contract.permission.previewCall?.(input as never)).toThrow(/changed/i);
	});

	it("summarises a file it would create rather than failing to read it", async () => {
		const cwd = await scratchDir();
		const definition = createEditToolDefinition(cwd);

		const preview = prepareThenPreview(definition, {
			path: "new.ts",
			edits: [{ oldText: "", newText: "const a = 1;" }],
		}) as { kind: string; reason?: string; lines?: readonly string[] };

		expect(["summary", "unavailable"]).toContain(preview.kind);
	});

	it("declines to draw a diff of a binary file", async () => {
		const cwd = await scratchDir();
		await writeFile(join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
		const definition = createEditToolDefinition(cwd);

		const preview = prepareThenPreview(definition, {
			path: "blob.bin",
			edits: [{ oldText: "x", newText: "y" }],
		}) as { kind: string; reason?: string };

		expect(preview.kind).toBe("unavailable");
		expect(preview.reason).toMatch(/binar/i);
	});
});

describe("the write preview", () => {
	it("says what it would replace, in lines and bytes", async () => {
		const cwd = await scratchDir();
		await writeFile(join(cwd, "a.ts"), "one\ntwo\nthree\n");
		const definition = createWriteToolDefinition(cwd);

		const preview = prepareThenPreview(definition, {
			path: "a.ts",
			content: "one\n",
		}) as { kind: string; lines: readonly string[] };

		expect(preview.kind).toBe("summary");
		expect(preview.lines.join(" ")).toMatch(/3 lines/);
		expect(preview.lines.join(" ")).toMatch(/1 line/);
	});

	it("says it would create a file that is not there yet", async () => {
		const cwd = await scratchDir();
		const definition = createWriteToolDefinition(cwd);

		const preview = prepareThenPreview(definition, { path: "new.ts", content: "hello\n" }) as {
			kind: string;
			lines: readonly string[];
		};

		expect(preview.kind).toBe("summary");
		expect(preview.lines.join(" ")).toMatch(/[Cc]reate/);
	});
});

describe("the bash preview", () => {
	it("shows the exact command, which is the whole of what is being authorized", () => {
		const definition = createBashToolDefinition(process.cwd());

		const preview = definition.contract.permission.previewCall?.({
			command: "rm -rf ./build && npm run build",
		} as never) as { kind: string; lines: readonly string[] };

		expect(preview.kind).toBe("summary");
		expect(preview.lines.join("\n")).toContain("rm -rf ./build && npm run build");
	});
});
