import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createSandboxPolicy,
	requireSandboxEnforcement,
	type SandboxStatus,
	SandboxUnavailableError,
} from "../../src/core/sandbox/policy.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function temporaryWorkspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("sandbox policy", () => {
	it("canonicalizes an existing absolute workspace and denies all hosts by default", () => {
		const workspace = temporaryWorkspace();
		const result = createSandboxPolicy({ workspace });

		// realpathSync(workspace), not workspace itself: canonicalization is a no-op
		// on platforms without a relevant symlink (Linux's /tmp), but on macOS
		// os.tmpdir() resolves through /var -> /private/var, and the whole point of
		// this test is that createSandboxPolicy resolves that, not that it doesn't.
		expect(result).toEqual({ kind: "valid", policy: { workspace: realpathSync(workspace), allowedHosts: [] } });
	});

	it("rejects a relative or missing workspace before an OS process is started", () => {
		expect(createSandboxPolicy({ workspace: "relative" })).toMatchObject({ kind: "invalid" });
		expect(createSandboxPolicy({ workspace: join(tmpdir(), "missing-apex-workspace") })).toMatchObject({
			kind: "invalid",
		});
	});

	it("fails closed when the backend is not enforcing the boundary", () => {
		const status: SandboxStatus = { kind: "unavailable", reason: "bubblewrap is unavailable" };

		expect(() => requireSandboxEnforcement(status)).toThrow(SandboxUnavailableError);
		expect(() => requireSandboxEnforcement(status)).toThrow("bubblewrap is unavailable");
	});
});

describe("SandboxViolationStore", () => {
	it("retains a bounded chronological tail without exposing mutable storage", () => {
		const store = new SandboxViolationStore({ capacity: 2 });
		store.add({ kind: "filesystem", command: "one", detail: "denied one", timestamp: new Date(1) });
		store.add({ kind: "network", command: "two", detail: "denied two", timestamp: new Date(2) });
		store.add({ kind: "unknown", command: "three", detail: "denied three", timestamp: new Date(3) });

		const violations = store.list();
		expect(violations.map((violation) => violation.command)).toEqual(["two", "three"]);
		const copiedViolations = [...violations];
		copiedViolations.pop();
		expect(store.list()).toHaveLength(2);
		expect(store.totalCount).toBe(3);
	});
});
