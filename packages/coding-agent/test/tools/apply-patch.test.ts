import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApplyPatchTool } from "../../src/core/tools/apply-patch.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-apply-patch-"));
	directories.push(directory);
	return directory;
}

describe("apply_patch", () => {
	it("applies both files or neither", async () => {
		const directory = scratch();
		writeFileSync(join(directory, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(directory, "b.ts"), "export const b = 1;\n");
		const tool = createApplyPatchTool(directory);
		await expect(
			tool.execute("both", {
				patches: [
					{ path: "a.ts", oldText: "export const a = 1;", newText: "export const a = 2;" },
					{ path: "b.ts", oldText: "missing", newText: "export const b = 2;" },
				],
			}),
		).rejects.toThrow(/b\.ts/);
		expect(readFileSync(join(directory, "a.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(readFileSync(join(directory, "b.ts"), "utf8")).toBe("export const b = 1;\n");
	});

	it("writes every file when every hunk matches", async () => {
		const directory = scratch();
		writeFileSync(join(directory, "a.ts"), "export const a = 1;\n");
		writeFileSync(join(directory, "b.ts"), "export const b = 1;\n");
		const tool = createApplyPatchTool(directory);
		const result = await tool.execute("ok", {
			patches: [
				{ path: "a.ts", oldText: "export const a = 1;", newText: "export const a = 2;" },
				{ path: "b.ts", oldText: "export const b = 1;", newText: "export const b = 2;" },
			],
		});
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(readFileSync(join(directory, "a.ts"), "utf8")).toContain("a = 2");
		expect(readFileSync(join(directory, "b.ts"), "utf8")).toContain("b = 2");
	});
});
