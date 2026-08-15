import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEvidenceSink } from "../../src/core/evidence.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const createdDirectories: string[] = [];

function createScratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-evidence-test-"));
	createdDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of createdDirectories.splice(0)) {
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	}
});

describe("SessionEvidenceSink", () => {
	it("persists bounded source evidence in additive JSONL entries that survive reload", () => {
		const workspace = createScratchDirectory();
		const sessions = join(workspace, "sessions");
		const session = SessionManager.create(workspace, sessions);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "ready" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sink = new SessionEvidenceSink(session);
		sink.record({ toolName: "bash", records: [{ kind: "command", command: "printf safe" }] });

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const reloaded = SessionManager.open(sessionFile!);
		const entry = reloaded.getEntries().find((candidate) => candidate.type === "evidence");
		expect(entry).toMatchObject({
			type: "evidence",
			toolName: "bash",
			records: [
				expect.objectContaining({
					facts: { kind: "command", command: "printf safe" },
					sessionId: session.getSessionId(),
					toolName: "bash",
				}),
			],
		});
	});

	it("rejects records with credential-shaped keys before persistence", () => {
		const workspace = createScratchDirectory();
		const sink = new SessionEvidenceSink(SessionManager.inMemory(workspace));

		expect(() =>
			sink.record({ toolName: "manual", records: [{ kind: "manual", value: { accessToken: "secret" } }] }),
		).toThrow("credential-shaped");
	});
});
