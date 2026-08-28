import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTerminalHandoff, observeTerminalHandoff } from "../../src/core/sandbox/terminal-handoff.ts";

const directories: string[] = [];
const stops: Array<() => void> = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

/**
 * Wait for the child side to catch up. The supervisor deliberately does not block on the
 * child resuming -- a contained process that could stall the supervisor there would be
 * able to veto the next prompt -- so the resume lands just after `borrowTerminal` returns.
 */
async function eventually(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (condition()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

function handoffDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-terminal-handoff-"));
	directories.push(directory);
	return directory;
}

describe("terminal handoff", () => {
	it("suspends the child, runs the prompt, then resumes it", async () => {
		const directory = handoffDirectory();
		const events: string[] = [];
		const handoff = createTerminalHandoff(directory);
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(directory, {
			suspend: () => {
				events.push("suspend");
			},
			resume: () => {
				events.push("resume");
			},
		});
		stops.push(observer.stop);

		const result = await handoff.borrowTerminal(async () => {
			events.push("prompt");
			return "answer";
		});

		expect(result).toBe("answer");
		await eventually(() => events.includes("resume"), "the child to resume");
		expect(events).toEqual(["suspend", "prompt", "resume"]);
	});

	it("waits for the child to acknowledge before running the prompt", async () => {
		const directory = handoffDirectory();
		const order: string[] = [];
		const handoff = createTerminalHandoff(directory);
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(directory, {
			suspend: async () => {
				await new Promise((r) => setTimeout(r, 60));
				order.push("child stopped drawing");
			},
			resume: () => {},
		});
		stops.push(observer.stop);

		await handoff.borrowTerminal(async () => {
			order.push("prompt drawn");
		});

		expect(order).toEqual(["child stopped drawing", "prompt drawn"]);
	});

	it("prompts anyway when no child ever acknowledges", async () => {
		// A hung or absent child must not be able to block the prompt: per ADR 0023 that
		// would let the contained side veto the human's decision. An unread prompt is a
		// legibility failure, which is the direction this is allowed to fail in.
		const directory = handoffDirectory();
		const handoff = createTerminalHandoff(directory, { acknowledgementTimeoutMs: 50 });
		stops.push(handoff.stop);

		await expect(handoff.borrowTerminal(async () => "ran")).resolves.toBe("ran");
	});

	it("resumes the child even when the prompt throws", async () => {
		const directory = handoffDirectory();
		const events: string[] = [];
		const handoff = createTerminalHandoff(directory);
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(directory, {
			suspend: () => {
				events.push("suspend");
			},
			resume: () => {
				events.push("resume");
			},
		});
		stops.push(observer.stop);

		await expect(
			handoff.borrowTerminal(async () => {
				throw new Error("prompt exploded");
			}),
		).rejects.toThrow("prompt exploded");
		await eventually(() => events.includes("resume"), "the child to resume after a failed prompt");
		expect(events).toEqual(["suspend", "resume"]);
	});

	it("serialises overlapping borrows so two prompts never share the terminal", async () => {
		const directory = handoffDirectory();
		const order: string[] = [];
		const handoff = createTerminalHandoff(directory);
		stops.push(handoff.stop);

		await Promise.all([
			handoff.borrowTerminal(async () => {
				order.push("first in");
				await new Promise((r) => setTimeout(r, 40));
				order.push("first out");
			}),
			handoff.borrowTerminal(async () => {
				order.push("second in");
				order.push("second out");
			}),
		]);

		expect(order).toEqual(["first in", "first out", "second in", "second out"]);
	});

	it("ignores a state file the child could not parse rather than acting on it", () => {
		const directory = handoffDirectory();
		const events: string[] = [];
		writeFileSync(join(directory, "terminal-handoff"), "not a known state\n");
		const observer = observeTerminalHandoff(directory, {
			suspend: () => {
				events.push("suspend");
			},
			resume: () => {
				events.push("resume");
			},
		});
		stops.push(observer.stop);

		expect(events).toEqual([]);
	});

	it("leaves no handoff state behind once the supervisor stops", async () => {
		const directory = handoffDirectory();
		const handoff = createTerminalHandoff(directory);
		await handoff.borrowTerminal(async () => undefined);
		handoff.stop();

		expect(readFileSync(join(directory, "terminal-handoff"), "utf8").trim()).toBe("resume");
	});
});
