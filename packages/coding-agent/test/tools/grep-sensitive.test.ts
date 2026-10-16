import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../../src/core/tools/grep.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-grep-sensitive-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

async function search(cwd: string, pattern: string): Promise<string> {
	const tool = createGrepTool(cwd);
	const result = await tool.execute("call", { pattern, path: "." });
	return (result.content[0] as { text: string }).text;
}

describe("grep skips sensitive files when it recurses (HR.2 gap)", () => {
	it("does not return the contents of a .env file found during a workspace search", async () => {
		const cwd = workspace({ ".env": "SECRET_TOKEN=abc123", "app.ts": "const token = 1; // TOKEN" });
		const text = await search(cwd, "TOKEN");
		expect(text).not.toContain("abc123");
		expect(text).toContain("app.ts");
	});

	it("still searches template env files", async () => {
		const cwd = workspace({ ".env.example": "API_TOKEN=", ".env.production": "PROD_TOKEN=xyz" });
		const text = await search(cwd, "TOKEN");
		expect(text).toContain(".env.example");
		expect(text).not.toContain("PROD_TOKEN=xyz");
	});
});
