import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import {
	EDIT_DIAGNOSTIC_MAX_FILE_BYTES,
	EDIT_DIAGNOSTIC_MAX_SCAN_WINDOWS,
	EDIT_DIAGNOSTIC_MAX_TARGET_BYTES,
} from "../../src/core/tools/edit-diff.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

/**
 * Public-boundary tests for bounded advisory edit-failure diagnostics
 * (spec 2026-09-01-tool-reliability-and-execution-budgets.md § 2).
 *
 * The matcher's apply path is authoritative: a diagnostic may name candidate
 * locations, but it must never turn a candidate into an applied replacement.
 * Every case drives the real edit tool through its execute boundary against a
 * scratch file and asserts the file bytes are untouched unless an edit applied.
 */

const directories: string[] = [];

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-edit-diagnostics-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createTool(cwd: string) {
	return wrapToolDefinition(createEditToolDefinition(cwd));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function expectEditFailure(
	cwd: string,
	params: { path: string; edits: Array<{ oldText: string; newText: string }> },
): Promise<Error> {
	const failure: unknown = await createTool(cwd)
		.execute("edit-call", params)
		.catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).not.toContain("Successfully replaced");
	return failure as Error;
}

function lines(from: number, to: number, text: (index: number) => string): string[] {
	const result: string[] = [];
	for (let i = from; i <= to; i++) result.push(text(i));
	return result;
}

describe("edit failure diagnostics", () => {
	it("reports advisory candidate locations for a missing match without applying anything", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "math.ts");
		const original = [
			"function sum(a, b) {",
			"\treturn a + b;",
			"}",
			"",
			"function product(a, b) {",
			"\treturn a * b;",
			"}",
		].join("\n");
		writeFileSync(path, original, "utf-8");

		const failure = await expectEditFailure(cwd, {
			path: "math.ts",
			edits: [{ oldText: "function sum(a, b) {\n\treturn a - b;\n}", newText: "replaced" }],
		});

		// The ordinary failure message is preserved as the first line.
		expect(failure.message.split("\n")[0]).toBe(
			"Could not find the exact text in math.ts. The old text must match exactly including all whitespace and newlines.",
		);
		expect(failure.message).toContain("Advisory");
		expect(failure.message).toContain("not applied");
		expect(failure.message).toContain("lines 1-3");
		expect(failure.message).toContain("return a + b;");
		// The near-miss must remain byte-identical on disk.
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	it("never applies an approximate match even when similarity is high", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "near-miss.ts");
		const original = [
			"export function total(items) {",
			"\tlet sum = 0;",
			"\tfor (const item of items) sum += item.price;",
			"\treturn sum;",
			"}",
		].join("\n");
		writeFileSync(path, original, "utf-8");
		const before = sha256(readFileSync(path, "utf-8"));

		// Differs by one identifier — scoring will find the block, matching will not.
		const failure = await expectEditFailure(cwd, {
			path: "near-miss.ts",
			edits: [
				{
					oldText:
						"export function total(items) {\n\tlet sum = 0;\n\tfor (const item of items) sum += item.value;\n\treturn sum;\n}",
					newText: "export function total(items) { /* replaced */ }",
				},
			],
		});

		expect(failure.message).toContain("Advisory");
		expect(failure.message).toContain("lines 1-5");
		expect(sha256(readFileSync(path, "utf-8"))).toBe(before);
	});

	it("reports duplicate occurrence line numbers", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "dupes.ts");
		const block = "function repeated() {\n\treturn 7;\n}";
		const original = [
			"// header",
			...lines(2, 3, () => "// filler"),
			block,
			...lines(5, 38, (i) => `// filler ${i}`),
			block,
		].join("\n");
		writeFileSync(path, original, "utf-8");
		const before = sha256(original);

		const failure = await expectEditFailure(cwd, {
			path: "dupes.ts",
			edits: [{ oldText: block, newText: "function unique() {\n\treturn 8;\n}" }],
		});

		expect(failure.message.split("\n")[0]).toContain("Found 2 occurrences of the text in dupes.ts");
		expect(failure.message).toContain("Advisory");
		// Each block spans three lines: the first starts at line 4, the second at 41.
		expect(failure.message).toMatch(/occurrence lines[^\n]*: 4, 41/);
		expect(sha256(readFileSync(path, "utf-8"))).toBe(before);
	});

	it("caps listed occurrences and says how many were omitted", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "many-dupes.txt");
		const original = lines(1, 8, (i) => `repeat-target alpha ${i}`).join("\n");
		writeFileSync(path, original, "utf-8");

		const failure = await expectEditFailure(cwd, {
			path: "many-dupes.txt",
			edits: [{ oldText: "repeat-target alpha", newText: "x" }],
		});

		expect(failure.message.split("\n")[0]).toContain("Found 8 occurrences");
		expect(failure.message).toContain("+3 more");
	});

	it("maps candidate lines correctly through a CRLF file", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "windows.ts");
		const body = ["// first", "// second", "function crlfTarget() {", "\treturn 'crlf';", "}"].join("\r\n");
		writeFileSync(path, body, "utf-8");

		const failure = await expectEditFailure(cwd, {
			path: "windows.ts",
			edits: [{ oldText: "function crlfTarget() {\n\treturn 'crif';\n}", newText: "x" }],
		});

		expect(failure.message).toContain("lines 3-5");
	});

	it("preserves tab indentation in reported snippets", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "tabs.ts");
		writeFileSync(
			path,
			["function tabbed() {", "\tconst value = 1;", "\treturn value + 1;", "}"].join("\n"),
			"utf-8",
		);

		const failure = await expectEditFailure(cwd, {
			path: "tabs.ts",
			edits: [{ oldText: "\tconst value = 2;\n\treturn value + 1;", newText: "x" }],
		});

		expect(failure.message).toContain("lines 2-3");
		expect(failure.message).toContain("2 | \tconst value = 1;");
		expect(failure.message).toContain("3 | \treturn value + 1;");
	});

	it("reports source line numbers safely when earlier lines contain multibyte characters", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "unicode.ts");
		writeFileSync(
			path,
			[
				"// ✅ covered — übersichtlich naïve",
				"// 🚀 more unicode 🎉",
				"function target() {",
				"\treturn 'value';",
				"}",
			].join("\n"),
			"utf-8",
		);

		const failure = await expectEditFailure(cwd, {
			path: "unicode.ts",
			edits: [{ oldText: "function target() {\n\treturn 'othervalue';\n}", newText: "x" }],
		});

		expect(failure.message).toContain("lines 3-5");
	});

	it("lists several candidate locations for repeated similar text", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "repeated.ts");
		writeFileSync(
			path,
			[
				"function handlerOne(req) {",
				"\tsend(res, 'ok');",
				"}",
				"// unrelated middle",
				"function handlerTwo(req) {",
				"\tsend(res, 'ok');",
				"}",
			].join("\n"),
			"utf-8",
		);

		const failure = await expectEditFailure(cwd, {
			path: "repeated.ts",
			edits: [{ oldText: "function handlerOne(req) {\n\tsend(res, 'accepted');\n}", newText: "x" }],
		});

		expect(failure.message).toContain("lines 1-3");
		expect(failure.message).toContain("lines 5-7");
	});

	it("returns the ordinary failure with a bounded notice when the file exceeds the scan budget", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "huge.txt");
		const chunk = "x".repeat(1024) + "\n";
		writeFileSync(path, chunk.repeat(Math.ceil((EDIT_DIAGNOSTIC_MAX_FILE_BYTES + 1024) / chunk.length)), "utf-8");

		const failure = await expectEditFailure(cwd, {
			path: "huge.txt",
			edits: [{ oldText: "this text is not present anywhere", newText: "x" }],
		});

		expect(failure.message.split("\n")[0]).toContain("Could not find the exact text in huge.txt");
		expect(failure.message).toContain("diagnostic scan skipped");
		expect(failure.message).toContain(String(EDIT_DIAGNOSTIC_MAX_FILE_BYTES));
		expect(failure.message.length).toBeLessThan(8192);
	}, 20000);

	it("returns the ordinary failure with a bounded notice when oldText exceeds the scan budget", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "small.txt");
		writeFileSync(path, "small file\n", "utf-8");

		const failure = await expectEditFailure(cwd, {
			path: "small.txt",
			edits: [{ oldText: "y".repeat(EDIT_DIAGNOSTIC_MAX_TARGET_BYTES + 1), newText: "x" }],
		});

		expect(failure.message).toContain("diagnostic scan skipped");
		expect(failure.message).toContain(String(EDIT_DIAGNOSTIC_MAX_TARGET_BYTES));
		expect(failure.message.length).toBeLessThan(8192);
	});

	it("truncates the advisory scan at the window cap and says so", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "wide-scan.txt");
		const total = EDIT_DIAGNOSTIC_MAX_SCAN_WINDOWS + 5000;
		writeFileSync(path, lines(1, total, (i) => `probe ${i} alpha beta gamma delta`).join("\n"), "utf-8");

		const failure = await expectEditFailure(cwd, {
			path: "wide-scan.txt",
			edits: [{ oldText: "probe 12345 alpha beta gamma epsilon", newText: "x" }],
		});

		expect(failure.message).toContain("scan truncated");
		expect(failure.message).toContain(String(EDIT_DIAGNOSTIC_MAX_SCAN_WINDOWS));
		expect(failure.message.length).toBeLessThan(8192);
	}, 20000);

	it("bounds every snippet line and the overall diagnostic size", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "long-line.txt");
		const longLine = Array.from({ length: 400 }, () => "word").join(" ");
		writeFileSync(path, `${longLine}\n`, "utf-8");

		// One word differs deep inside the long line; the snippet must still be bounded.
		const target = longLine.replace(/word (?=word$)/, "wurd ");
		const failure = await expectEditFailure(cwd, {
			path: "long-line.txt",
			edits: [{ oldText: target, newText: "x" }],
		});

		expect(failure.message.length).toBeLessThan(8192);
		expect(failure.message).toContain("…");
	});

	it("names the failing edit index in multi-edit calls and diagnoses only that edit", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "multi.ts");
		writeFileSync(
			path,
			["function keep() {", "\treturn 1;", "}", "function lose() {", "\treturn 2;", "}"].join("\n"),
			"utf-8",
		);

		const failure = await expectEditFailure(cwd, {
			path: "multi.ts",
			edits: [
				{ oldText: "function keep() {\n\treturn 1;\n}", newText: "function keep() {\n\treturn 11;\n}" },
				{ oldText: "function lose() {\n\treturn 3;\n}", newText: "function lose() {\n\treturn 33;\n}" },
			],
		});

		expect(failure.message.split("\n")[0]).toContain("Could not find edits[1] in multi.ts");
		expect(failure.message).toContain("lines 4-6");
	});
});
