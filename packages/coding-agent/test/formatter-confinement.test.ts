/**
 * PS.2: a formatter's workspace mutations are confined to its declared paths.
 *
 * The earlier lifecycle ran the formatter directly in the live workspace and
 * reported undeclared writes afterwards. Reporting a write that already
 * happened is not confinement: the stray bytes were on disk before anything
 * looked. These cases assert the live workspace bytes, not the report.
 *
 * The mechanism is an isolated copy plus restricted promotion. It confines
 * workspace mutation to the declared set. It does not confine host-wide
 * absolute-path writes or network access, which are the OS boundary's job.
 * The absolute-path case below records that limit rather than claiming it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFormatterCommand } from "../src/core/formatter-lifecycle.ts";
import type { FormatterPolicy } from "../src/core/policy-loader.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-ps2-"));
	directories.push(dir);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf-8");
	writeFileSync(join(dir, "stray.txt"), "original\n", "utf-8");
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

const script = (body: string): string[] => ["-e", body];

describe("formatter confinement", () => {
	it("keeps an undeclared write out of the live workspace", async () => {
		const root = scratchWorkspace();

		const outcome = await runFormatterCommand(
			policy(
				script(
					`require("fs").writeFileSync("src/a.ts", "declared\\n");` +
						`require("fs").writeFileSync("stray.txt", "undeclared\\n")`,
				),
			),
			{ workspaceRoot: root },
		);

		expect(readFileSync(join(root, "stray.txt"), "utf-8")).toBe("original\n");
		expect(outcome.status).toBe("scope-violated");
		expect(outcome.mutations.undeclaredPaths).toContain("stray.txt");
	});

	it("promotes a declared change even when the run also violated scope", async () => {
		const root = scratchWorkspace();

		await runFormatterCommand(
			policy(
				script(
					`require("fs").writeFileSync("src/a.ts", "declared\\n");` +
						`require("fs").writeFileSync("stray.txt", "undeclared\\n")`,
				),
			),
			{ workspaceRoot: root },
		);

		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("declared\n");
	});

	it("creates no undeclared new file in the live workspace", async () => {
		const root = scratchWorkspace();

		const outcome = await runFormatterCommand(
			policy(script(`require("fs").writeFileSync("invented.txt", "new\\n")`)),
			{ workspaceRoot: root },
		);

		expect(existsSync(join(root, "invented.txt"))).toBe(false);
		expect(outcome.status).toBe("scope-violated");
	});

	it("never reports passed when scope was violated", async () => {
		const root = scratchWorkspace();

		const outcome = await runFormatterCommand(
			policy(script(`require("fs").writeFileSync("stray.txt", "undeclared\\n")`)),
			{ workspaceRoot: root },
		);

		expect(outcome.status).not.toBe("passed");
	});

	it("does not overwrite a file the user changed during the run", async () => {
		const root = scratchWorkspace();
		const concurrent = join(root, "src", "a.ts");

		const outcome = await runFormatterCommand(
			policy(
				script(
					`require("fs").writeFileSync("src/a.ts", "formatter\\n");` +
						`require("fs").writeFileSync(${JSON.stringify(concurrent)}, "user edit\\n")`,
				),
			),
			{ workspaceRoot: root },
		);

		expect(readFileSync(concurrent, "utf-8")).toBe("user edit\n");
		expect(outcome.status).not.toBe("passed");
	});

	it("still promotes a declared-only change and passes", async () => {
		const root = scratchWorkspace();

		const outcome = await runFormatterCommand(
			policy(script(`require("fs").writeFileSync("src/a.ts", "export const a = 2;\\n")`)),
			{ workspaceRoot: root },
		);

		expect(outcome.status).toBe("passed");
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("export const a = 2;\n");
		expect(outcome.mutations.changedPaths).toEqual(["src/a.ts"]);
		expect(outcome.mutations.undeclaredPaths).toEqual([]);
	});

	it("leaves the workspace untouched when the formatter writes nothing", async () => {
		const root = scratchWorkspace();

		const outcome = await runFormatterCommand(policy(script("process.exit(0)")), { workspaceRoot: root });

		expect(outcome.status).toBe("passed");
		expect(outcome.mutations.unchanged).toBe(true);
		expect(readFileSync(join(root, "src", "a.ts"), "utf-8")).toBe("export const a = 1;\n");
	});

	/**
	 * The sharp case for the no-follow promotion write. The formatter plants a
	 * symlink at the live target whose content is byte-identical to the pre-run
	 * fingerprint, so the concurrent-edit guard sees no change and promotion
	 * proceeds. Only the no-follow open stands between the promoted bytes and
	 * the outside file.
	 */
	it("does not follow a symlink planted at the live promotion target", async () => {
		const outside = mkdtempSync(join(tmpdir(), "apex-ps2-outside-"));
		directories.push(outside);
		const target = join(outside, "secret.txt");
		writeFileSync(target, "export const a = 1;\n", "utf-8");
		const root = scratchWorkspace();
		const live = join(root, "src", "a.ts");

		const outcome = await runFormatterCommand(
			policy(
				script(
					`const fs = require("fs");` +
						`fs.writeFileSync("src/a.ts", "formatter\\n");` +
						`fs.rmSync(${JSON.stringify(live)});` +
						`fs.symlinkSync(${JSON.stringify(target)}, ${JSON.stringify(live)})`,
				),
			),
			{ workspaceRoot: root },
		);

		expect(readFileSync(target, "utf-8")).toBe("export const a = 1;\n");
		expect(outcome.status).not.toBe("passed");
	});

	/**
	 * A recorded limit, not a guarantee. Copy plus restricted promotion confines
	 * workspace mutation. It cannot stop a formatter writing an absolute path
	 * outside the workspace, and the stage diff cannot see that write, so the
	 * run still reports `passed`. Nothing in the harness blocks this. ADR 0032
	 * removed the OS boundary, so the CLI and an SDK embedding are the same case,
	 * and containment is the operator's container or VM.
	 *
	 * This case exists so the limit cannot silently become a false claim.
	 */
	it("records that an absolute write outside the workspace is not confined", async () => {
		const outside = mkdtempSync(join(tmpdir(), "apex-ps2-limit-"));
		directories.push(outside);
		const target = join(outside, "reachable.txt");
		const root = scratchWorkspace();

		const outcome = await runFormatterCommand(
			policy(script(`require("fs").writeFileSync(${JSON.stringify(target)}, "reached\\n")`)),
			{ workspaceRoot: root },
		);

		expect(readFileSync(target, "utf-8")).toBe("reached\n");
		expect(outcome.mutations.unchanged).toBe(true);
	});
});
