import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowScripts } from "../../src/core/delegation/workflow-files.ts";

const scratch: string[] = [];

afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dir(): string {
	const created = mkdtempSync(join(tmpdir(), "apex-workflows-"));
	scratch.push(created);
	return created;
}

describe("loadWorkflowScripts", () => {
	it("reads a script's name, description, and body", () => {
		const root = dir();
		writeFileSync(join(root, "audit.js"), "---\nname: audit\ndescription: Check routes\n---\nreturn 1\n");
		const loaded = loadWorkflowScripts(root);
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.scripts).toEqual([
			{ name: "audit", description: "Check routes", body: "return 1", path: join(root, "audit.js") },
		]);
	});

	it("refuses a symlinked script and a symlinked directory", () => {
		const root = dir();
		const real = join(root, "real.js");
		writeFileSync(real, "---\nname: real\ndescription: Real\n---\nreturn 1\n");
		symlinkSync(real, join(root, "linked.js"));
		const loaded = loadWorkflowScripts(root);
		expect(loaded.scripts.map((script) => script.name)).toEqual(["real"]);
		expect(loaded.diagnostics.some((line) => line.includes("linked.js"))).toBe(true);

		const elsewhere = dir();
		symlinkSync(root, join(elsewhere, "workflows"));
		const through = loadWorkflowScripts(join(elsewhere, "workflows"));
		expect(through.scripts).toEqual([]);
		expect(through.diagnostics[0]).toMatch(/symlink/);
	});

	it("reports a file that has no name", () => {
		const root = dir();
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "bare.js"), "return 1\n");
		const loaded = loadWorkflowScripts(root);
		expect(loaded.scripts).toEqual([]);
		expect(loaded.diagnostics[0]).toMatch(/name/);
	});
});
