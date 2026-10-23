import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptMemoryNote, appendMemoryNote, loadAcceptedMemoryNotes } from "../src/core/memory-notes.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-memory-"));
	directories.push(dir);
	return dir;
}

describe("memory notes", () => {
	it("writes an inbox note that does not load", () => {
		const dir = scratch();
		const written = appendMemoryNote(dir, { title: "Use tabs", body: "This repo indents with tabs." });
		expect(written.refused).toBeUndefined();
		expect(written.path).toBeDefined();
		expect(written.name).toBeDefined();
		expect(readFileSync(written.path!, "utf-8")).toContain("This repo indents with tabs.");
		expect(loadAcceptedMemoryNotes(dir, { projectTrusted: true }).text).toBe("");
	});

	it("loads a note only after it is accepted", () => {
		const dir = scratch();
		const written = appendMemoryNote(dir, { title: "Use tabs", body: "This repo indents with tabs." });
		acceptMemoryNote(dir, written.name!);
		const loaded = loadAcceptedMemoryNotes(dir, { projectTrusted: true });
		expect(loaded.text).toContain("This repo indents with tabs.");
	});

	it("does not load accepted notes when the project is untrusted", () => {
		const dir = scratch();
		const written = appendMemoryNote(dir, { title: "Use tabs", body: "This repo indents with tabs." });
		acceptMemoryNote(dir, written.name!);
		expect(loadAcceptedMemoryNotes(dir, { projectTrusted: false }).text).toBe("");
	});

	it("stops loading at 200 lines and says where it stopped", () => {
		const dir = scratch();
		const body = Array.from({ length: 210 }, (_, index) => `line ${index + 1}`).join("\n");
		const written = appendMemoryNote(dir, { title: "Long", body });
		acceptMemoryNote(dir, written.name!);
		const loaded = loadAcceptedMemoryNotes(dir, { projectTrusted: true });
		expect(loaded.text).toContain("line 200");
		expect(loaded.text).not.toContain("line 201");
		expect(loaded.cut).toBe("200 lines");
	});

	it("refuses a note that contains a secret and writes nothing", () => {
		const dir = scratch();
		const written = appendMemoryNote(dir, { title: "Key", body: "api_key=sk-live" });
		expect(written.refused).toMatch(/secret/);
		expect(written.path).toBeUndefined();
	});
});
