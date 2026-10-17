import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { FileReadLedger } from "../../src/core/tools/file-ledger.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import { createWriteTool } from "../../src/core/tools/write.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-ledger-tools-"));
	dirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function run(tool: { execute: (...args: never[]) => Promise<unknown> }, input: Record<string, unknown>) {
	return (tool.execute as unknown as (id: string, input: Record<string, unknown>) => Promise<unknown>)("call", input);
}

describe("read ledger enforced by the tools (HR.24)", () => {
	it("write refuses to replace an existing file the model has not read", async () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "a.txt"), "original");
		const ledger = new FileReadLedger();
		const write = createWriteTool(cwd, { ledger });
		await expect(run(write, { path: "a.txt", content: "replaced" })).rejects.toThrow(/has not been read/);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("original");
	});

	it("write proceeds after a full read", async () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "a.txt"), "original");
		const ledger = new FileReadLedger();
		await run(createReadTool(cwd, { ledger }), { path: "a.txt" });
		await run(createWriteTool(cwd, { ledger }), { path: "a.txt", content: "replaced" });
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("replaced");
	});

	it("write refuses after a partial read", async () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree");
		const ledger = new FileReadLedger();
		await run(createReadTool(cwd, { ledger }), { path: "a.txt", offset: 2, limit: 1 });
		await expect(run(createWriteTool(cwd, { ledger }), { path: "a.txt", content: "x" })).rejects.toThrow(
			/only part of the file was read/,
		);
	});

	it("edit refuses a file changed on disk since the read", async () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "a.txt"), "alpha");
		const ledger = new FileReadLedger();
		await run(createReadTool(cwd, { ledger }), { path: "a.txt" });
		writeFileSync(join(cwd, "a.txt"), "changed elsewhere");
		await expect(
			run(createEditTool(cwd, { ledger }), { path: "a.txt", edits: [{ oldText: "changed", newText: "x" }] }),
		).rejects.toThrow(/changed on disk/);
	});

	it("without a ledger the tools behave as before", async () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "a.txt"), "original");
		await run(createWriteTool(cwd), { path: "a.txt", content: "replaced" });
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("replaced");
	});
});
