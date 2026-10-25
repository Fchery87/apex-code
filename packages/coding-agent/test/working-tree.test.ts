import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workingTreeReport } from "../src/modes/interactive/working-tree.ts";

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("working tree report", () => {
	it("says when the directory is not a repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-diff-"));
		const report = await workingTreeReport(dir);
		expect(report).toBe("Not a git repository.");
	});

	it("lists a changed file and an untracked file, and caps a long diff", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-diff-"));
		git(dir, ["init"]);
		git(dir, ["config", "user.email", "test@example.com"]);
		git(dir, ["config", "user.name", "Test"]);
		writeFileSync(join(dir, "tracked.txt"), "one\n");
		git(dir, ["add", "tracked.txt"]);
		git(dir, ["commit", "-m", "start"]);
		writeFileSync(join(dir, "tracked.txt"), "two\n");
		writeFileSync(join(dir, "new.txt"), "untracked\n");

		const report = await workingTreeReport(dir, { maxDiffLines: 0 });
		expect(report).toContain("tracked.txt");
		expect(report).toContain("new.txt");
		expect(report).toContain("omitted");
	});
});
