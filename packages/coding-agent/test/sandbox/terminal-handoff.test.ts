import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
	// Generous relative to the 100ms poll, so a slow runner cannot fail this on timing
	// alone; the assertion that resume is *prompt* lives in its own test with a real bound.
	for (let attempt = 0; attempt < 400; attempt++) {
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

	it("delivers a resume promptly, not whenever the platform watcher gets round to it", async () => {
		// macOS CI delivered a resume more than a second after it was written, and
		// intermittently: `fs.watch` is a thin wrapper over whatever the platform provides
		// and FSEvents is entitled to take its time. The event does arrive, but a TUI that
		// sits frozen for a second after the human answered is the same thing as broken to
		// the person looking at it. The bound here is what the poll guarantees, well under
		// the several seconds the unaided watcher was observed taking.
		const directory = handoffDirectory();
		const seen: string[] = [];
		const handoff = createTerminalHandoff(directory, { acknowledgementTimeoutMs: 50 });
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(directory, {
			suspend: () => {
				seen.push("suspend");
			},
			resume: () => {
				seen.push("resume");
			},
		});
		stops.push(observer.stop);

		await handoff.borrowTerminal(async () => undefined);
		const startedAt = Date.now();
		await eventually(() => seen.includes("resume"), "the child to resume");

		expect(seen).toEqual(["suspend", "resume"]);
		expect(Date.now() - startedAt).toBeLessThan(1_500);
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

	// PS.3. The supervisor's suspend/resume writes are host writes made on behalf of the
	// human. A symlink planted at the state path -- which the child could do while the
	// state directory lived under the workspace -- must not redirect them onto a host file
	// the child could never reach itself.
	// O_NOFOLLOW is a POSIX guarantee; Windows has no sandbox backend (ADR 0005).
	it.skipIf(process.platform === "win32")("does not follow a symlink planted at the state path", async () => {
		const directory = handoffDirectory();
		const outside = join(handoffDirectory(), "outside.txt");
		writeFileSync(outside, "untouched");
		symlinkSync(outside, join(directory, "terminal-handoff"));

		const handoff = createTerminalHandoff(directory, { acknowledgementTimeoutMs: 50 });
		stops.push(handoff.stop);
		await expect(handoff.borrowTerminal(async () => "ran")).resolves.toBe("ran");
		handoff.stop();

		expect(readFileSync(outside, "utf8")).toBe("untouched");
		expect(lstatSync(join(directory, "terminal-handoff")).isSymbolicLink()).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"does not read an acknowledgement through a symlink planted at the acknowledgement path",
		async () => {
			const directory = handoffDirectory();
			const acknowledgementPath = join(directory, "terminal-handoff-ack");
			const outside = join(handoffDirectory(), "outside-ack.txt");
			writeFileSync(outside, "suspended\n");

			const handoff = createTerminalHandoff(directory, { acknowledgementTimeoutMs: 800 });
			stops.push(handoff.stop);
			const startedAt = Date.now();
			const elapsed = handoff.borrowTerminal(async () => Date.now() - startedAt);
			// After the stale-acknowledgement removal, so the link is present for every read
			// the supervisor makes while it waits.
			await new Promise((r) => setTimeout(r, 100));
			symlinkSync(outside, acknowledgementPath);

			// Followed, the planted link would satisfy the wait within one poll interval.
			expect(await elapsed).toBeGreaterThanOrEqual(600);
			expect(readFileSync(outside, "utf8")).toBe("suspended\n");
		},
	);

	it("separates the supervisor's command path from the child-writable acknowledgement path", async () => {
		const commandDirectory = handoffDirectory();
		const acknowledgementPath = join(handoffDirectory(), "terminal-handoff-ack");
		const events: string[] = [];
		const handoff = createTerminalHandoff(commandDirectory, { acknowledgementPath });
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(
			commandDirectory,
			{
				suspend: () => {
					events.push("suspend");
				},
				resume: () => {
					events.push("resume");
				},
			},
			{ acknowledgementPath },
		);
		stops.push(observer.stop);

		await handoff.borrowTerminal(async () => {
			events.push("prompt");
		});

		expect(events).toEqual(["suspend", "prompt"]);
		expect(existsSync(acknowledgementPath)).toBe(true);
		expect(existsSync(join(commandDirectory, "terminal-handoff-ack"))).toBe(false);
	});
});
