import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The macOS case, made deterministic. `fs.watch` there is FSEvents, which is entitled to
 * deliver late or not at all within a test's lifetime, so the poll is the only guarantee.
 * Neutering the watcher outright is the difference between exercising that path and
 * hoping the scheduler exercises it.
 */
vi.mock("node:fs", async () => {
	const real = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...real, watch: () => ({ close: () => {} }) };
});

const { createTerminalHandoff, observeTerminalHandoff } = await import("../../src/core/sandbox/terminal-handoff.ts");

const directories: string[] = [];
const stops: Array<() => void> = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function handoffDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-handoff-no-watcher-"));
	directories.push(directory);
	return directory;
}

describe("terminal handoff without a working watcher", () => {
	it("delivers both halves of a borrow even with a short acknowledgement timeout", async () => {
		// 50ms is below POLL_INTERVAL_MS. Unfloored, the supervisor gives up and writes
		// `resume` over its own `suspend` before the child samples once, and the child
		// reads a single value equal to the one it already held: neither hook runs.
		const directory = handoffDirectory();
		const seen: string[] = [];
		const handoff = createTerminalHandoff(directory, { acknowledgementTimeoutMs: 50 });
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(directory, {
			suspend: () => void seen.push("suspend"),
			resume: () => void seen.push("resume"),
		});
		stops.push(observer.stop);

		await handoff.borrowTerminal(async () => undefined);
		await vi.waitFor(() => expect(seen).toEqual(["suspend", "resume"]), { timeout: 5_000, interval: 25 });
	});

	it("waits for the child rather than timing out, so the prompt has the terminal", async () => {
		const directory = handoffDirectory();
		const order: string[] = [];
		const handoff = createTerminalHandoff(directory, { acknowledgementTimeoutMs: 50 });
		stops.push(handoff.stop);
		const observer = observeTerminalHandoff(directory, {
			suspend: () => void order.push("child stopped drawing"),
			resume: () => {},
		});
		stops.push(observer.stop);

		await handoff.borrowTerminal(async () => {
			order.push("prompt drawn");
		});

		expect(order).toEqual(["child stopped drawing", "prompt drawn"]);
	});
});
