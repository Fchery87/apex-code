import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPolicyConfiguration, type VerificationPolicy } from "../src/core/policy-loader.ts";
import { type VerificationCompletionStatus, VerificationTracker } from "../src/core/verification-lifecycle.ts";

/**
 * VF.4 (spec 2026-09-01-configured-verification-and-formatting.md § 4): the
 * verification lifecycle. The tracker owns one thing — turning bounded
 * executor outcomes into the five completion statuses the spec names, and
 * retiring a result the moment the workspace it described changes. It never
 * flips failed to passed, and a stale result never presents as current.
 */

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-verify-"));
	directories.push(dir);
	mkdirSync(join(dir, "sub"), { recursive: true });
	return dir;
}

function passPolicy(overrides: Partial<VerificationPolicy> = {}): VerificationPolicy {
	return {
		id: "typecheck",
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

describe("verification lifecycle: completion statuses", () => {
	it("starts unavailable when nothing is configured or has run", () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		expect(tracker.completionStatus()).toBe("unavailable");
	});

	it("maps a passing non-blocking policy to verified success", async () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.configure([passPolicy()], "explicit");
		const record = await tracker.runExplicit();
		expect(record?.outcome).toBe("verified");
		expect(tracker.completionStatus()).toBe("verified");
	});

	it("maps a failing policy to failed, blocking or not", async () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.configure([passPolicy({ argv: ["-e", "process.exit(1)"], blocksCompletion: true })], "explicit");
		const record = await tracker.runExplicit();
		expect(record?.outcome).toBe("failed");
		expect(tracker.completionStatus()).toBe("failed");
		expect(record?.evidence[0].exitCode).toBe(1);
	});

	it("maps timeout and cancellation to interrupted, never to verified", async () => {
		const timeoutTracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		timeoutTracker.configure(
			[passPolicy({ argv: ["-e", "setTimeout(() => {}, 60_000)"], timeoutMs: 300 })],
			"explicit",
		);
		await timeoutTracker.runExplicit();
		expect(timeoutTracker.completionStatus()).toBe("interrupted");

		const controller = new AbortController();
		const cancelTracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		cancelTracker.configure([passPolicy({ argv: ["-e", "setTimeout(() => {}, 60_000)"] })], "explicit");
		setTimeout(() => controller.abort(), 150);
		await cancelTracker.runExplicit(undefined, { signal: controller.signal });
		expect(cancelTracker.completionStatus()).toBe("interrupted");
	});

	it("distinguishes continue-without-verification as its own status", () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.recordContinuedWithoutVerification();
		expect(tracker.completionStatus()).toBe("continued-unverified");
	});

	it("keeps the latest policy's result when several are configured", async () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.configure(
			[passPolicy({ id: "first" }), passPolicy({ id: "second", argv: ["-e", "process.exit(2)"] })],
			"explicit",
		);
		const record = await tracker.runExplicit("first");
		expect(record?.evidence[0].policyId).toBe("first");
		const later = await tracker.runExplicit("second");
		expect(later?.evidence[0].policyId).toBe("second");
		expect(tracker.completionStatus()).toBe("failed");
	});
});

describe("verification lifecycle: staleness and evidence", () => {
	it("retires a result when the workspace changes after the run", async () => {
		const root = scratchWorkspace();
		const tracker = new VerificationTracker({ workspaceRoot: root });
		tracker.configure([passPolicy()], "explicit");
		await tracker.runExplicit();
		expect(tracker.completionStatus()).toBe("verified");

		writeFileSync(join(root, "sub", "new-file.ts"), "export {}", "utf-8");
		tracker.noteWorkspaceChange(new Set([join(root, "sub", "new-file.ts")]));
		expect(tracker.completionStatus()).toBe("unavailable");
	});

	it("does not retire a result when nothing relevant changed", async () => {
		const root = scratchWorkspace();
		const tracker = new VerificationTracker({ workspaceRoot: root });
		tracker.configure([passPolicy()], "explicit");
		await tracker.runExplicit();
		tracker.noteWorkspaceChange(new Set());
		expect(tracker.completionStatus()).toBe("verified");
	});

	it("carries bounded evidence only: no full output in the record", async () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.configure(
			[passPolicy({ argv: ["-e", "console.log('x'.repeat(80_000))"], maxOutputBytes: 512 })],
			"explicit",
		);
		const record = await tracker.runExplicit();
		expect(record).toBeDefined();
		const evidence = record!.evidence[0];
		expect(evidence.policyId).toBe("typecheck");
		expect(evidence.executable).toBe(process.execPath);
		expect(evidence.argv).toEqual(["-e", "console.log('x'.repeat(80_000))"]);
		expect(evidence.status).toBe("passed");
		expect(evidence.truncated).toBe(true);
		expect(JSON.stringify(record)).not.toContain("xxxxx");
	});

	it("reports unavailable when the requested policy id is not configured", async () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.configure([passPolicy()], "explicit");
		const record = await tracker.runExplicit("missing");
		expect(record).toBeUndefined();
		expect(tracker.completionStatus()).toBe("unavailable");
	});

	it("exposes the loaded policies so callers can list what verification means", () => {
		const tracker = new VerificationTracker({ workspaceRoot: scratchWorkspace() });
		tracker.configure([passPolicy(), passPolicy({ id: "lint" })], "explicit");
		expect(tracker.policyIds()).toEqual(["typecheck", "lint"]);
	});

	it("survives a loader round trip: settings to policies to statuses", async () => {
		const root = scratchWorkspace();
		const snapshot = loadPolicyConfiguration({
			globalSettings: {
				schemaVersion: 1,
				verification: [
					{
						id: "typecheck",
						executable: process.execPath,
						argv: ["-e", "process.exit(0)"],
					},
				],
			},
			projectSettings: undefined,
			projectTrusted: false,
		});
		const tracker = new VerificationTracker({ workspaceRoot: root });
		tracker.configure(snapshot.verification, "explicit");
		await tracker.runExplicit();
		const status: VerificationCompletionStatus = tracker.completionStatus();
		expect(status).toBe("verified");
	});
});
