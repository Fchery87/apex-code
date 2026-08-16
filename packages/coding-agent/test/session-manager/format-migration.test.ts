import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FileEntry, migrateSessionEntries, SessionManager } from "../../src/core/session-manager.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function scratchDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `apex-format-migration-${label}-`));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeJsonl(path: string, lines: unknown[]): void {
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("hookMessage -> custom role rename (v2 -> v3), unit level", () => {
	it("renames hookMessage to custom and preserves the message content", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "hookMessage", content: "pre-tool-use hook output", timestamp: 1 },
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		const migrated = entries[1] as unknown as { message: { role: string; content: string } };
		expect(migrated.message.role).toBe("custom");
		expect(migrated.message.content).toBe("pre-tool-use hook output");
	});
});

describe("session-format migration through the real production load path (task 9.2)", () => {
	it("migrates a v1 session file (no version, no id/parentId) on SessionManager.open, preserving message content, tool calls, and usage", () => {
		const dir = scratchDir("v1");
		const sessionFile = join(dir, "session.jsonl");

		writeJsonl(sessionFile, [
			// v1 header: no "version" field at all.
			{ type: "session", id: "v1-session", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" },
			// v1 entries: no id/parentId -- assigned only by migration.
			{
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "list files", timestamp: 1 },
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I'll list the files." },
						{ type: "toolCall", id: "call-1", name: "ls", input: { path: "." } },
					],
					api: "test-api",
					provider: "test-provider",
					model: "test-model",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				timestamp: "2025-01-01T00:00:03Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "ls",
					content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
					isError: false,
					timestamp: 3,
				},
			},
		]);

		const sessionManager = SessionManager.open(sessionFile, dir);

		const entries = sessionManager.getEntries();
		expect(entries).toHaveLength(3);

		// Tree structure was assigned by migration.
		const [userEntry, assistantEntry, toolResultEntry] = entries as Array<{ id: string; parentId: string | null }>;
		expect(userEntry.parentId).toBeNull();
		expect(assistantEntry.parentId).toBe(userEntry.id);
		expect(toolResultEntry.parentId).toBe(assistantEntry.id);

		// Content survived migration unchanged.
		const userMessage = entries[0] as { message: { role: string; content: string } };
		expect(userMessage.message.content).toBe("list files");

		const assistantMessage = entries[1] as {
			message: { content: Array<{ type: string; text?: string; name?: string }>; usage: { input: number } };
		};
		expect(assistantMessage.message.content).toEqual([
			{ type: "text", text: "I'll list the files." },
			{ type: "toolCall", id: "call-1", name: "ls", input: { path: "." } },
		]);
		expect(assistantMessage.message.usage.input).toBe(10);

		const toolResultMessage = entries[2] as { message: { toolName: string; content: Array<{ text: string }> } };
		expect(toolResultMessage.message.toolName).toBe("ls");
		expect(toolResultMessage.message.content[0].text).toBe("file1.txt\nfile2.txt");

		// The file itself was rewritten at the current version.
		const rewritten = readFileSync(sessionFile, "utf-8");
		const header = JSON.parse(rewritten.split("\n")[0]);
		expect(header.version).toBe(3);
	});

	it("migrates a v2 session file (has id/parentId, no role rename yet) on SessionManager.open, renaming hookMessage to custom", () => {
		const dir = scratchDir("v2");
		const sessionFile = join(dir, "session.jsonl");

		writeJsonl(sessionFile, [
			{ type: "session", id: "v2-session", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" },
			{
				type: "message",
				id: "aaaaaaaa",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "run the pre-commit hook", timestamp: 1 },
			},
			{
				type: "message",
				id: "bbbbbbbb",
				parentId: "aaaaaaaa",
				timestamp: "2025-01-01T00:00:02Z",
				message: { role: "hookMessage", content: "pre-commit: 3 files checked, 0 issues", timestamp: 2 },
			},
		]);

		const sessionManager = SessionManager.open(sessionFile, dir);
		const entries = sessionManager.getEntries();

		expect(entries).toHaveLength(2);
		// Tree structure (already v2-shaped) is untouched by migration.
		const hookEntry = entries[1] as {
			id: string;
			parentId: string | null;
			message: { role: string; content: string };
		};
		expect(hookEntry.id).toBe("bbbbbbbb");
		expect(hookEntry.parentId).toBe("aaaaaaaa");
		// Role renamed, content preserved.
		expect(hookEntry.message.role).toBe("custom");
		expect(hookEntry.message.content).toBe("pre-commit: 3 files checked, 0 issues");

		const rewritten = readFileSync(sessionFile, "utf-8");
		const header = JSON.parse(rewritten.split("\n")[0]);
		expect(header.version).toBe(3);
	});

	it("does not rewrite a file that is already at the current version", () => {
		const dir = scratchDir("v3");
		const sessionFile = join(dir, "session.jsonl");

		writeJsonl(sessionFile, [
			{ type: "session", id: "v3-session", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp/project" },
			{
				type: "message",
				id: "aaaaaaaa",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			},
		]);
		const before = readFileSync(sessionFile, "utf-8");

		SessionManager.open(sessionFile, dir);

		const after = readFileSync(sessionFile, "utf-8");
		expect(after).toBe(before);
	});
});
