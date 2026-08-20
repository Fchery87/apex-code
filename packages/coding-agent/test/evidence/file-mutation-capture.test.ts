import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const directories: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-file-evidence-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("file mutation source evidence", () => {
	it("captures a write byte count and content hash without retaining file contents", async () => {
		const cwd = scratchDirectory();
		const definition = createWriteToolDefinition(cwd);
		const params = { path: "created.txt", content: "private file body" };
		const result = await wrapToolDefinition(definition).execute("call-write", params);

		expect(readFileSync(join(cwd, params.path), "utf8")).toBe(params.content);
		expect([...definition.contract.evidence.emits]).toEqual(["diff"]);
		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{
				kind: "diff",
				path: params.path,
				byteCount: Buffer.byteLength(params.content),
				contentHash: sha256(params.content),
			},
		]);
	});

	it("captures an edit patch hash without retaining patch text", async () => {
		const cwd = scratchDirectory();
		const path = join(cwd, "edited.txt");
		writeFileSync(path, "one\ntwo\n");
		const definition = createEditToolDefinition(cwd);
		const params = { path: "edited.txt", edits: [{ oldText: "two", newText: "three" }] };
		const result = await wrapToolDefinition(definition).execute("call-edit", params);

		expect(readFileSync(path, "utf8")).toBe("one\nthree\n");
		const evidence = definition.contract.evidence.capture(params, result);
		expect(evidence).toEqual([
			expect.objectContaining({ kind: "diff", path: params.path, patchHash: expect.any(String) }),
		]);
		expect(JSON.stringify(evidence)).not.toContain("three");
	});

	it("captures diagnostic severity totals without retaining server-controlled content", async () => {
		const cwd = scratchDirectory();
		const definition = createWriteToolDefinition(cwd, {
			diagnosticsOperations: {
				afterMutation: async () => ({
					status: "ok",
					serverId: "typescript",
					truncated: false,
					diagnostics: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							severity: 1,
							message: "private source text",
						},
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							message: "another private diagnostic",
						},
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
							severity: -1,
							message: "unknown severity",
						},
					],
				}),
			},
		});
		const params = { path: "index.ts", content: "const value = true;\n" };
		const result = await wrapToolDefinition(definition).execute("call-write", params);

		expect([...definition.contract.evidence.emits]).toEqual(["diff", "diagnostic"]);
		const evidence = definition.contract.evidence.capture(params, result);
		expect(evidence).toEqual([
			expect.objectContaining({ kind: "diff", path: params.path }),
			{
				kind: "diagnostic",
				path: params.path,
				status: "ok",
				serverId: "typescript",
				diagnosticCount: 3,
				severityCounts: { error: 1, warning: 0, information: 0, hint: 0, unspecified: 1, other: 1 },
				truncated: false,
			},
		]);
		expect(JSON.stringify(evidence)).not.toContain("private source text");
	});

	it("captures a stable unavailable kind without retaining the rendered reason", async () => {
		const cwd = scratchDirectory();
		const definition = createEditToolDefinition(cwd, {
			diagnosticsOperations: {
				afterMutation: async () => ({
					status: "unavailable",
					serverId: "typescript",
					unavailableKind: "server-failed",
					reason: "server leaked /private/workspace/path",
				}),
			},
		});
		const path = join(cwd, "edited.ts");
		writeFileSync(path, "const before = true;\n");
		const params = { path: "edited.ts", edits: [{ oldText: "before", newText: "after" }] };
		const result = await wrapToolDefinition(definition).execute("call-edit", params);

		const evidence = definition.contract.evidence.capture(params, result);
		expect(evidence).toContainEqual({
			kind: "diagnostic",
			path: params.path,
			status: "unavailable",
			serverId: "typescript",
			unavailableKind: "server-failed",
		});
		expect(JSON.stringify(evidence)).not.toContain("/private/workspace/path");
	});
});
