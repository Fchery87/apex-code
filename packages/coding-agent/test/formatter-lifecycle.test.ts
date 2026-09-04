import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFormatterCommand } from "../src/core/formatter-lifecycle.ts";
import type { FormatterPolicy } from "../src/core/policy-loader.ts";

/**
 * VF.5 (spec 2026-09-01-configured-verification-and-formatting.md § 2): the
 * formatter lifecycle. A formatter runs inside its declared scope, and the
 * before/after comparison is the evidence: which declared paths changed,
 * which changed paths were never declared, and which writes escaped the
 * workspace through a symlink or a traversal. Nothing is reverted — the
 * report is honest, the workspace is the user's.
 */

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-vf5-"));
	directories.push(dir);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
	return dir;
}

function policy(argv: string[], overrides: Partial<FormatterPolicy> = {}): FormatterPolicy {
	return {
		id: "format",
		executable: process.execPath,
		argv,
		cwd: "workspace",
		timeoutMs: 30_000,
		maxOutputBytes: 262_144,
		maxOutputLines: 2_000,
		shell: false,
		permission: "allow",
		trustedSource: "user",
		kind: "formatter",
		mutatesFiles: true,
		declaredPaths: ["src/**/*.ts"],
		...overrides,
	};
}

const rewriteDeclared = ["-e", `require("fs").writeFileSync("src/a.ts", "export const a = 2;\\n")`];
const touchNothing = ["-e", "process.exit(0)"];

describe("formatter lifecycle: declared scope and mutation reporting", () => {
	it("reports a declared mutation and nothing undeclared", async () => {
		const root = scratchWorkspace();
		const outcome = await runFormatterCommand(policy(rewriteDeclared), { workspaceRoot: root });
		expect(outcome.status).toBe("passed");
		expect(outcome.mutations.unchanged).toBe(false);
		expect(outcome.mutations.changedPaths).toEqual(["src/a.ts"]);
		expect(outcome.mutations.undeclaredPaths).toEqual([]);
		expect(outcome.mutations.escapedPaths).toEqual([]);
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("export const a = 2;\n");
	});

	it("reports an unchanged workspace when the formatter writes nothing", async () => {
		const root = scratchWorkspace();
		const outcome = await runFormatterCommand(policy(touchNothing), { workspaceRoot: root });
		expect(outcome.status).toBe("passed");
		expect(outcome.mutations.unchanged).toBe(true);
		expect(outcome.mutations.changedPaths).toEqual([]);
	});

	it("reports a formatter failure with whatever mutations happened", async () => {
		const root = scratchWorkspace();
		const outcome = await runFormatterCommand(
			policy(["-e", `require("fs").writeFileSync("src/a.ts", "half"); process.exit(1)`]),
			{ workspaceRoot: root },
		);
		expect(outcome.status).toBe("failed");
		expect(outcome.evidence.exitCode).toBe(1);
		expect(outcome.mutations.changedPaths).toEqual(["src/a.ts"]);
	});

	it("flags writes outside declaredPaths as unexpected mutations", async () => {
		const root = scratchWorkspace();
		writeFileSync(join(root, "stray.txt"), "before", "utf-8");
		const outcome = await runFormatterCommand(
			policy([
				"-e",
				`const fs = require("fs"); fs.writeFileSync("src/a.ts", "two"); fs.writeFileSync("stray.txt", "after")`,
			]),
			{ workspaceRoot: root },
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.mutations.changedPaths.sort()).toEqual(["src/a.ts", "stray.txt"]);
		expect(outcome.mutations.undeclaredPaths).toEqual(["stray.txt"]);
	});

	it("treats paths outside pathScope as unexpected even when declared elsewhere", async () => {
		const root = scratchWorkspace();
		mkdirSync(join(root, "other"), { recursive: true });
		writeFileSync(join(root, "other", "x.ts"), "before", "utf-8");
		const outcome = await runFormatterCommand(
			policy(
				[
					"-e",
					`const fs = require("fs"); fs.writeFileSync("src/a.ts", "two"); fs.writeFileSync("other/x.ts", "after")`,
				],
				{
					declaredPaths: ["src/**/*.ts", "other/**/*.ts"],
					pathScope: ["src/**"],
				},
			),
			{ workspaceRoot: root },
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.mutations.undeclaredPaths).toEqual(["other/x.ts"]);
	});

	it("refuses traversal patterns before running anything", async () => {
		const root = scratchWorkspace();
		const outcome = await runFormatterCommand(policy(rewriteDeclared, { declaredPaths: ["../outside/**/*.ts"] }), {
			workspaceRoot: root,
		});
		expect(outcome.status).toBe("refused");
		expect(outcome.evidence.durationMs).toBe(0);
		expect(existsSync(join(root, "src", "a.ts"))).toBe(true);
	});

	it("flags symlink escapes as escaped paths rather than declared mutations", async () => {
		const root = scratchWorkspace();
		const outside = mkdtempSync(join(tmpdir(), "apex-vf5-outside-"));
		directories.push(outside);
		const target = join(outside, "real.ts");
		writeFileSync(target, "original", "utf-8");
		try {
			symlinkSync(target, join(root, "src", "linked.ts"));
		} catch {
			// Symlink creation is privilege-gated on Windows; the CI matrix
			// covers the escape detection on POSIX where it is reliable.
			return;
		}
		const outcome = await runFormatterCommand(
			policy(["-e", `require("fs").writeFileSync("src/linked.ts", "rewritten")`]),
			{ workspaceRoot: root },
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.mutations.escapedPaths).toEqual(["src/linked.ts"]);
		expect(outcome.mutations.changedPaths).toContain("src/linked.ts");
	}, 15_000);

	it("reports a timeout with tree cleanup and no false mutation claim", async () => {
		const root = scratchWorkspace();
		const outcome = await runFormatterCommand(policy(["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 400 }), {
			workspaceRoot: root,
		});
		expect(outcome.status).toBe("timeout");
		expect(outcome.mutations.unchanged).toBe(true);
	});

	it("supports mid-run cancellation", async () => {
		const root = scratchWorkspace();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const outcome = await runFormatterCommand(policy(["-e", "setTimeout(() => {}, 60_000)"]), {
			workspaceRoot: root,
			signal: controller.signal,
		});
		expect(outcome.status).toBe("cancelled");
	});

	it("carries bounded evidence and no raw output", async () => {
		const root = scratchWorkspace();
		const outcome = await runFormatterCommand(
			policy(["-e", `console.log("y".repeat(50_000)); require("fs").writeFileSync("src/a.ts", "two")`], {
				maxOutputBytes: 512,
			}),
			{ workspaceRoot: root },
		);
		expect(outcome.evidence.policyId).toBe("format");
		expect(outcome.evidence.truncated).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain("yyyyy");
	});
});
