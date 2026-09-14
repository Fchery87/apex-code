import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionMode } from "../../src/core/permissions/store.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

/**
 * `acceptEdits` decided on capability shape alone, with no path term reachable:
 * `params` is not a parameter of `resolveWithMode`. While the process boundary existed
 * the mounts made "an edit" mean the workspace, so the missing term cost nothing. ADR 0032
 * deleted the mounts and the mode silently became a grant over every path the account
 * can write, while still describing itself as "plain file edits".
 *
 * Each case drives a real session with the gate installed. The first case is the control:
 * without it, a blocked write proves nothing, because a harness with no gate blocks
 * nothing and a broken gate blocks everything.
 */
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function session(mode: PermissionMode) {
	const harness = await createHarness({
		permissionGate: {
			store: new FilePermissionRuleStore({ cwd: process.cwd(), projectTrusted: true }),
			getMode: () => mode,
		},
	});
	harnesses.push(harness);
	return harness;
}

async function attemptWrite(harness: Harness, path: string): Promise<boolean> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path, content: "WRITTEN" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("write it");
	try {
		return readFileSync(path, "utf8").includes("WRITTEN");
	} catch {
		return false;
	}
}

describe("acceptEdits is scoped to the workspace", () => {
	it("CONTROL an ask-shaped write is refused in default mode with no responder", async () => {
		const harness = await session("default");
		expect(await attemptWrite(harness, join(harness.tempDir, "inside.txt"))).toBe(false);
	});

	it("still auto-allows an edit inside the workspace, which is the mode's whole purpose", async () => {
		const harness = await session("acceptEdits");
		expect(await attemptWrite(harness, join(harness.tempDir, "nested", "inside.txt"))).toBe(true);
	});

	it("refuses a write outside the workspace", async () => {
		const harness = await session("acceptEdits");
		const outside = join(harness.tempDir, "..", `outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			expect(await attemptWrite(harness, join(outside, "planted.txt"))).toBe(false);
			expect(existsSync(outside), "the parent chain must not be created either").toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("refuses a write through a symlink that leaves the workspace", async () => {
		const harness = await session("acceptEdits");
		const outside = join(harness.tempDir, "..", `linked-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "target.txt"), "ORIGINAL");
		symlinkSync(outside, join(harness.tempDir, "escape"));
		try {
			expect(await attemptWrite(harness, join(harness.tempDir, "escape", "target.txt"))).toBe(false);
			expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("ORIGINAL");
		} finally {
			rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});
});
