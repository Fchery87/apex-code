import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPolicyCommand } from "../src/core/policy-executor.ts";
import type { VerificationPolicy } from "../src/core/policy-loader.ts";
import { WorkspaceArtifactStore } from "../src/core/workspace/artifacts.ts";

/**
 * VF.3 (spec 2026-09-01-configured-verification-and-formatting.md § 2):
 * the bounded argv executor. Every command runs through executable+argv
 * spawn with no shell, under the policy's numeric bounds, with process-tree
 * termination on timeout and cancellation. Outcomes are structured values —
 * the executor never throws for a command that merely fails.
 *
 * All child commands use `node -e` scripts so the suite is portable across
 * the three CI operating systems without shell-specific syntax.
 */

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-policy-exec-"));
	directories.push(dir);
	return dir;
}

function policy(overrides: Partial<VerificationPolicy> = {}): VerificationPolicy {
	return {
		id: "probe",
		executable: process.execPath,
		argv: ["-e", "process.exit(0)"],
		cwd: "workspace",
		timeoutMs: 30_000,
		maxOutputBytes: 262_144,
		maxOutputLines: 2_000,
		shell: false,
		permission: "allow",
		trustedSource: "user",
		kind: "verification",
		blocksCompletion: false,
		...overrides,
	};
}

describe("policy executor: outcomes", () => {
	it("reports a passing command", async () => {
		const outcome = await runPolicyCommand(policy(), { workspaceRoot: scratch() });
		expect(outcome.status).toBe("passed");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
		expect(outcome.policyId).toBe("probe");
		expect(outcome.executable).toBe(process.execPath);
		expect(outcome.argv).toEqual(["-e", "process.exit(0)"]);
	});

	it("reports a failing command with its exit code", async () => {
		const outcome = await runPolicyCommand(policy({ argv: ["-e", "process.exit(3)"] }), { workspaceRoot: scratch() });
		expect(outcome.status).toBe("failed");
		expect(outcome.exitCode).toBe(3);
	});

	it("reports a spawn failure as a structured outcome, never a throw", async () => {
		const outcome = await runPolicyCommand(policy({ executable: "definitely-not-a-real-binary-vf3", argv: [] }), {
			workspaceRoot: scratch(),
		});
		expect(outcome.status).toBe("spawn-failed");
		expect(outcome.refusalReason).toBeTruthy();
	});

	it("kills a command past its timeout and reports it", async () => {
		const outcome = await runPolicyCommand(policy({ argv: ["-e", "setTimeout(() => {}, 60_000)"], timeoutMs: 500 }), {
			workspaceRoot: scratch(),
		});
		expect(outcome.status).toBe("timeout");
		expect(outcome.durationMs).toBeLessThan(15_000);
	});

	it("kills a command when cancellation fires mid-run", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const outcome = await runPolicyCommand(policy({ argv: ["-e", "setTimeout(() => {}, 60_000)"] }), {
			workspaceRoot: scratch(),
			signal: controller.signal,
		});
		expect(outcome.status).toBe("cancelled");
		expect(outcome.durationMs).toBeLessThan(15_000);
	});

	it("refuses a policy that was already cancelled before spawning", async () => {
		const controller = new AbortController();
		controller.abort();
		const outcome = await runPolicyCommand(policy(), { workspaceRoot: scratch(), signal: controller.signal });
		expect(outcome.status).toBe("cancelled");
	});

	it("kills the whole process tree on timeout", async () => {
		const dir = scratch();
		const pidFile = join(dir, "grandchild.pid");
		const parentScript = [
			`const { spawn } = require("child_process");`,
			`const gc = spawn(process.execPath, ["-e",`,
			`  "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)",`,
			`  ${JSON.stringify(pidFile)}], { stdio: "ignore" });`,
			`setTimeout(() => {}, 60000);`,
		].join("\n");
		const outcome = await runPolicyCommand(policy({ argv: ["-e", parentScript], timeoutMs: 800 }), {
			workspaceRoot: dir,
		});
		expect(outcome.status).toBe("timeout");

		// The grandchild writes its pid once running; poll briefly, then wait
		// for the killed tree to actually release it.
		let grandchildPid: number | undefined;
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			try {
				const pid = Number.parseInt(readFileSyncText(pidFile), 10);
				if (Number.isInteger(pid) && pid > 0) {
					grandchildPid = pid;
					break;
				}
			} catch {
				// not written yet
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(grandchildPid).toBeDefined();

		const released = await (async () => {
			const settle = Date.now() + 5_000;
			for (;;) {
				try {
					process.kill(grandchildPid!, 0);
					if (Date.now() > settle) return false;
					await new Promise((resolve) => setTimeout(resolve, 100));
				} catch {
					return true;
				}
			}
		})();
		expect(released).toBe(true);
	}, 20_000);
});

function readFileSyncText(path: string): string {
	// eslint-disable-next-line -- local helper keeps the test readable
	const { readFileSync } = require("node:fs") as typeof import("node:fs");
	return readFileSync(path, "utf-8");
}

describe("policy executor: output bounds and safety", () => {
	it("decodes UTF-8 output without mojibake", async () => {
		const outcome = await runPolicyCommand(
			policy({ argv: ["-e", `console.log("héllo 🎉 done")]`.replace("]", "")] }),
			{
				workspaceRoot: scratch(),
			},
		);
		expect(outcome.outputExcerpt).toContain("héllo 🎉 done");
	});

	it("truncates output past maxOutputBytes while reporting the true byte count", async () => {
		const outcome = await runPolicyCommand(
			policy({ argv: ["-e", "process.stdout.write('a'.repeat(200_000))"], maxOutputBytes: 1_024 }),
			{ workspaceRoot: scratch() },
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.truncated).toBe(true);
		expect(outcome.stdoutBytes).toBe(200_000);
		expect(outcome.outputExcerpt.length).toBeLessThan(4_096);
	});

	it("limits the excerpt to maxOutputLines", async () => {
		const outcome = await runPolicyCommand(
			policy({ argv: ["-e", "for (let i = 0; i < 100; i++) console.log('line', i)"], maxOutputLines: 10 }),
			{ workspaceRoot: scratch() },
		);
		expect(outcome.status).toBe("passed");
		const excerptLines = outcome.outputExcerpt.trim().split("\n");
		expect(excerptLines.length).toBeLessThanOrEqual(10);
	});

	it("passes shell metacharacters through as literal argv, never a shell script", async () => {
		const nasty = "a && b | c; rm -rf / $(echo pwned)";
		const outcome = await runPolicyCommand(policy({ argv: ["-e", "console.log(process.argv[1])", nasty] }), {
			workspaceRoot: scratch(),
		});
		expect(outcome.status).toBe("passed");
		expect(outcome.outputExcerpt).toContain(nasty);
		expect(outcome.outputExcerpt).not.toContain("pwned\npwned");
	});

	it("resolves a relative cwd against the workspace root", async () => {
		const root = scratch();
		mkdirSync(join(root, "sub", "dir"), { recursive: true });
		const outcome = await runPolicyCommand(policy({ argv: ["-e", "console.log(process.cwd())"], cwd: "sub/dir" }), {
			workspaceRoot: root,
		});
		expect(outcome.status).toBe("passed");
		expect(outcome.cwd).toBe(join(root, "sub", "dir"));
	});

	it("refuses a cwd that escapes the workspace without spawning", async () => {
		const outcome = await runPolicyCommand(policy({ cwd: "../outside" }), { workspaceRoot: scratch() });
		expect(outcome.status).toBe("refused");
		expect(outcome.refusalReason).toContain("workspace");
	});

	it("retains full output as an artifact when a store is provided", async () => {
		const root = scratch();
		const store = new WorkspaceArtifactStore(join(root, "session.jsonl"));
		const outcome = await runPolicyCommand(
			policy({ argv: ["-e", "process.stdout.write('b'.repeat(100_000))"], maxOutputBytes: 1_024 }),
			{ workspaceRoot: root, artifactStore: store },
		);
		expect(outcome.status).toBe("passed");
		expect(outcome.artifact).toBeDefined();
		expect(outcome.artifact!.bytes).toBe(100_000);
		const read = await store.readArtifact(outcome.artifact!, { allowed: true });
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.bytes.byteLength).toBe(100_000);
		}
	});
});
