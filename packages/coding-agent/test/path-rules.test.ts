import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { matchingPathRules } from "../src/core/path-rules.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

describe("path rules", () => {
	it("returns a rule whose glob matches the path and skips one that does not", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-rules-"));
		directories.push(dir);
		mkdirSync(join(dir, ".apex-code", "rules"), { recursive: true });
		writeFileSync(
			join(dir, ".apex-code", "rules", "tabs.md"),
			"---\npaths:\n  - src/**/*.ts\n---\nIndent TypeScript with tabs.\n",
		);
		writeFileSync(join(dir, ".apex-code", "rules", "docs.md"), "---\npaths:\n  - docs/**\n---\nDocs stay short.\n");
		const matched = matchingPathRules(dir, "src/core/memory-notes.ts");
		expect(matched.map((rule) => rule.body)).toEqual(["Indent TypeScript with tabs."]);
	});

	it("appends the matching rule when the file is read", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-rules-"));
		directories.push(dir);
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".apex-code", "rules"), { recursive: true });
		writeFileSync(join(dir, "src", "note.ts"), "export const value = 1;\n");
		writeFileSync(
			join(dir, ".apex-code", "rules", "tabs.md"),
			"---\npaths:\n  - src/**/*.ts\n---\nIndent TypeScript with tabs.\n",
		);
		const tool = createReadToolDefinition(dir);
		const result = await tool.execute("call-1", { path: "src/note.ts" }, undefined, undefined, undefined as never);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("export const value = 1;");
		expect(text).toContain("Indent TypeScript with tabs.");
	});

	it("appends the matching rule when the file is edited", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-rules-"));
		directories.push(dir);
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".apex-code", "rules"), { recursive: true });
		writeFileSync(join(dir, "src", "note.ts"), "export const value = 1;\n");
		writeFileSync(
			join(dir, ".apex-code", "rules", "tabs.md"),
			"---\npaths:\n  - src/**/*.ts\n---\nIndent TypeScript with tabs.\n",
		);
		const tool = createEditToolDefinition(dir);
		const result = await tool.execute(
			"call-1",
			{ path: "src/note.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] },
			undefined,
			undefined,
			undefined as never,
		);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("Successfully replaced");
		expect(text).toContain("Indent TypeScript with tabs.");
	});

	it("returns nothing for a file with no frontmatter paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-rules-"));
		directories.push(dir);
		mkdirSync(join(dir, ".apex-code", "rules"), { recursive: true });
		writeFileSync(join(dir, ".apex-code", "rules", "plain.md"), "No frontmatter.\n");
		expect(matchingPathRules(dir, "src/core/memory-notes.ts")).toEqual([]);
	});
});
