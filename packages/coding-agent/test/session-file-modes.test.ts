import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posixOnly = process.platform === "win32" ? it.skip : it;

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-session-modes-"));
	dirs.push(dir);
	return dir;
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

const assistantReply = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	api: "faux",
	provider: "faux",
	model: "faux",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	stopReason: "stop",
	timestamp: 0,
} as never;

function sessionWithReply(root: string, sessionDir: string): SessionManager {
	const session = SessionManager.create(root, sessionDir);
	session.appendMessage({ role: "user", content: "hello", timestamp: 0 } as never);
	session.appendMessage(assistantReply);
	return session;
}

describe("session file permissions (HR.6)", () => {
	posixOnly("a new session file is owner-only", () => {
		const root = scratch();
		const session = sessionWithReply(root, join(root, "sessions"));
		const file = session.getSessionFile() as string;
		expect(existsSync(file)).toBe(true);
		expect(mode(file)).toBe(0o600);
	});

	posixOnly("the session directory is owner-only", () => {
		const root = scratch();
		const sessionDir = join(root, "sessions");
		sessionWithReply(root, sessionDir);
		expect(mode(sessionDir)).toBe(0o700);
	});

	posixOnly("an existing group-readable session file is tightened when it is opened", () => {
		const root = scratch();
		const sessionDir = join(root, "sessions");
		const file = sessionWithReply(root, sessionDir).getSessionFile() as string;
		chmodSync(file, 0o664);
		SessionManager.open(file, sessionDir);
		expect(mode(file)).toBe(0o600);
		expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
	});
});
