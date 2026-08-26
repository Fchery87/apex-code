import { type FSWatcher, readFileSync, watch, writeFileSync } from "node:fs";

/**
 * Carries the host terminal's size across the sandbox boundary.
 *
 * The sandboxed child runs under `bwrap --new-session`, so it has no
 * controlling terminal: the kernel never sends it SIGWINCH, and the window size
 * its stdout reports is frozen at whatever it was when the sandbox was created.
 * Everything downstream reads `process.stdout.columns`, so a resize left the TUI
 * rendering to a width the terminal no longer had.
 *
 * The supervisor owns a real TTY and does get the resize event. It publishes the
 * new size to a file inside the workspace, which is already bind-mounted into
 * the sandbox; the child watches that file and republishes it as a `resize` on
 * its own stdout. Signals are deliberately not used as the transport: bwrap sits
 * between the two processes as PID 1 and does not forward SIGWINCH.
 */

/** Env var naming the file both sides agree on. */
export const TERMINAL_SIZE_PATH_VARIABLE = "APEX_TERMINAL_SIZE_PATH";

export interface TerminalSize {
	columns: number;
	rows: number;
}

function formatSize(size: TerminalSize): string {
	return `${size.columns} ${size.rows}\n`;
}

export function parseTerminalSize(contents: string): TerminalSize | undefined {
	const [columns, rows] = contents.trim().split(/\s+/).map(Number);
	if (!Number.isInteger(columns) || !Number.isInteger(rows)) return undefined;
	if (columns <= 0 || rows <= 0) return undefined;
	return { columns, rows };
}

/**
 * Host side. Publishes the current size, then republishes on every resize.
 * Returns a stop function; the caller must run it on every launch exit path.
 */
export function publishTerminalSize(path: string, stdout: NodeJS.WriteStream = process.stdout): () => void {
	if (!stdout.isTTY) return () => {};

	const write = () => {
		const columns = stdout.columns;
		const rows = stdout.rows;
		if (!Number.isInteger(columns) || !Number.isInteger(rows)) return;
		try {
			writeFileSync(path, formatSize({ columns, rows }));
		} catch {
			// A size we cannot publish is not worth failing a launch over.
		}
	};

	write();
	stdout.on("resize", write);
	return () => {
		stdout.off("resize", write);
	};
}

/**
 * Child side. Applies the published size to `process.stdout` and keeps applying
 * it as the file changes.
 *
 * `columns` and `rows` are redefined as getters because Node recomputes them
 * from the sandbox's own console on SIGWINCH, which is exactly the stale value
 * this exists to override. The setters swallow those writes rather than throwing.
 */
export function applyTerminalSize(
	path: string,
	stdout: NodeJS.WriteStream = process.stdout,
): { stop: () => void; refresh: () => void } {
	let current: TerminalSize | undefined;

	const refresh = () => {
		let size: TerminalSize | undefined;
		try {
			size = parseTerminalSize(readFileSync(path, "utf8"));
		} catch {
			return;
		}
		if (!size) return;
		if (current && current.columns === size.columns && current.rows === size.rows) return;
		current = size;
		Object.defineProperty(stdout, "columns", {
			configurable: true,
			get: () => current?.columns,
			set: () => {},
		});
		Object.defineProperty(stdout, "rows", {
			configurable: true,
			get: () => current?.rows,
			set: () => {},
		});
		stdout.emit("resize");
	};

	refresh();

	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(path, refresh);
	} catch {
		// Without a watcher the initial size still applies; only live resize is lost.
	}

	return {
		refresh,
		stop: () => {
			watcher?.close();
		},
	};
}
