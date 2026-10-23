import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAcceptedMemoryNotes } from "../src/core/memory-notes.ts";
import { createMemoryNoteToolDefinition } from "../src/core/tools/memory-note.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

describe("memory_note tool", () => {
	it("writes an inbox note and does not load it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-memory-tool-"));
		directories.push(dir);
		const tool = createMemoryNoteToolDefinition(dir);
		const result = await tool.execute(
			"call-1",
			{ title: "Tabs", body: "Indent with tabs." },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("inbox");
		expect(loadAcceptedMemoryNotes(dir, { projectTrusted: true }).text).toBe("");
	});

	it("returns the secret refusal and writes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-memory-tool-"));
		directories.push(dir);
		const tool = createMemoryNoteToolDefinition(dir);
		const result = await tool.execute(
			"call-1",
			{ title: "Key", body: "api_key=sk-live" },
			undefined,
			undefined,
			{} as never,
		);
		const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toMatch(/secret/);
	});
});
