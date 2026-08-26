import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyTerminalSize, parseTerminalSize, publishTerminalSize } from "../src/core/sandbox/terminal-size.ts";

/** Minimal stand-in for a tty WriteStream. */
function fakeStdout(options: { isTTY: boolean; columns?: number; rows?: number }): NodeJS.WriteStream {
	const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
	Object.assign(stream, { isTTY: options.isTTY, columns: options.columns, rows: options.rows });
	return stream;
}

let directory: string;
let path: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "apex-winsize-"));
	path = join(directory, "terminal-size");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("parseTerminalSize", () => {
	it("reads a well-formed size", () => {
		expect(parseTerminalSize("120 40\n")).toEqual({ columns: 120, rows: 40 });
	});

	it("rejects anything that is not two positive integers", () => {
		for (const input of ["", "  ", "80", "80 x", "0 40", "80 0", "-5 40", "80.5 40", "garbage"]) {
			expect(parseTerminalSize(input), `accepted ${JSON.stringify(input)}`).toBeUndefined();
		}
	});
});

describe("publishTerminalSize", () => {
	it("writes the current size immediately and again on every resize", () => {
		const stdout = fakeStdout({ isTTY: true, columns: 100, rows: 30 });
		const stop = publishTerminalSize(path, stdout);

		expect(parseTerminalSize(readFileSync(path, "utf8"))).toEqual({ columns: 100, rows: 30 });

		Object.assign(stdout, { columns: 60, rows: 20 });
		stdout.emit("resize");
		expect(parseTerminalSize(readFileSync(path, "utf8"))).toEqual({ columns: 60, rows: 20 });

		stop();
		Object.assign(stdout, { columns: 200, rows: 50 });
		stdout.emit("resize");
		expect(parseTerminalSize(readFileSync(path, "utf8")), "stop() must detach").toEqual({ columns: 60, rows: 20 });
	});

	it("writes nothing when stdout is not a terminal", () => {
		const stop = publishTerminalSize(path, fakeStdout({ isTTY: false, columns: 100, rows: 30 }));
		expect(() => readFileSync(path, "utf8")).toThrow();
		stop();
	});
});

describe("applyTerminalSize", () => {
	it("adopts the published size and announces it as a resize", () => {
		writeFileSync(path, "72 24\n");
		// The sandbox reports a frozen size; the published one must win.
		const stdout = fakeStdout({ isTTY: true, columns: 100, rows: 30 });
		let resizes = 0;
		stdout.on("resize", () => {
			resizes += 1;
		});

		const { stop } = applyTerminalSize(path, stdout);
		expect(stdout.columns).toBe(72);
		expect(stdout.rows).toBe(24);
		expect(resizes).toBe(1);
		stop();
	});

	it("re-reads on refresh and stays quiet when the size is unchanged", () => {
		writeFileSync(path, "72 24\n");
		const stdout = fakeStdout({ isTTY: true, columns: 100, rows: 30 });
		let resizes = 0;
		stdout.on("resize", () => {
			resizes += 1;
		});

		const { stop, refresh } = applyTerminalSize(path, stdout);
		expect(resizes).toBe(1);

		refresh();
		expect(resizes, "an unchanged size must not churn a redraw").toBe(1);

		writeFileSync(path, "48 18\n");
		refresh();
		expect(stdout.columns).toBe(48);
		expect(stdout.rows).toBe(18);
		expect(resizes).toBe(2);
		stop();
	});

	it("survives Node writing the sandbox's stale size back over it", () => {
		// Node recomputes columns from the sandbox console on SIGWINCH. The
		// override must swallow that write rather than throw or regress.
		writeFileSync(path, "72 24\n");
		const stdout = fakeStdout({ isTTY: true, columns: 100, rows: 30 });
		const { stop } = applyTerminalSize(path, stdout);

		expect(() => {
			(stdout as { columns: number }).columns = 100;
		}).not.toThrow();
		expect(stdout.columns).toBe(72);
		stop();
	});

	it("leaves stdout alone when the file is missing or malformed", () => {
		const stdout = fakeStdout({ isTTY: true, columns: 100, rows: 30 });
		let resizes = 0;
		stdout.on("resize", () => {
			resizes += 1;
		});

		const missing = applyTerminalSize(join(directory, "absent"), stdout);
		expect(stdout.columns).toBe(100);
		expect(resizes).toBe(0);
		missing.stop();

		writeFileSync(path, "not a size\n");
		const malformed = applyTerminalSize(path, stdout);
		expect(stdout.columns).toBe(100);
		expect(resizes).toBe(0);
		malformed.stop();
	});
});
