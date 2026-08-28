import { type FSWatcher, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Lends the terminal from the sandboxed child back to the supervisor for a prompt.
 *
 * The supervisor has to draw the escalation prompt itself. Per ADR 0023 an approval
 * asserted from inside the boundary is indistinguishable from one forged by the code the
 * boundary exists to contain, so the human's answer must be read by the side that owns the
 * decision. The child cannot read it in any case: it runs under `bwrap --new-session` and
 * has no controlling terminal, which `terminal-size.ts` documents for the same reason.
 *
 * The transport is the one `terminal-size.ts` already established -- a file in the
 * workspace, which is bind-mounted into the child, watched on the other side. Signals are
 * unavailable because bwrap sits between the processes as PID 1 and forwards nothing.
 *
 * Two files rather than one, because the supervisor must know the child has actually let
 * go of stdin before it reads an answer. The child inherits stdin and its TUI holds it in
 * raw mode; prompting while both sides read would lose keystrokes to whichever won.
 *
 * The child is asked, never obeyed. A child that never acknowledges delays the prompt by
 * the timeout and no longer, because a contained process that could withhold
 * acknowledgement indefinitely would be able to veto the human's decision -- which is the
 * authority failure ADR 0023 forbids. An unread prompt is a legibility failure, and that
 * is the direction this is allowed to fail in.
 */

/** Env var naming the directory both sides agree on. */
export const TERMINAL_HANDOFF_PATH_VARIABLE = "APEX_TERMINAL_HANDOFF_PATH";

const STATE_FILE = "terminal-handoff";
const ACKNOWLEDGEMENT_FILE = "terminal-handoff-ack";
const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 1_000;

/**
 * How often each side re-reads the state file, independently of the watcher.
 *
 * `fs.watch` is a thin wrapper over whatever the platform provides, and the platforms do
 * not agree. macOS CI delivered a resume more than a second after it was written, and
 * intermittently: the event arrives, late enough that a TUI would sit visibly frozen
 * after the human had already answered. The watcher still does the work in the common
 * case; this only bounds how wrong it can be.
 */
const POLL_INTERVAL_MS = 100;

type HandoffState = "suspend" | "resume";

function parseState(contents: string): HandoffState | undefined {
	const value = contents.trim();
	return value === "suspend" || value === "resume" ? value : undefined;
}

export interface TerminalHandoff {
	/**
	 * Suspend the child, run `prompt` with the terminal to itself, then resume the child.
	 * Overlapping calls are serialised, so two prompts never share the terminal.
	 */
	borrowTerminal<T>(prompt: () => Promise<T>): Promise<T>;
	stop(): void;
}

/** Supervisor side. */
export function createTerminalHandoff(
	directory: string,
	options?: { acknowledgementTimeoutMs?: number },
): TerminalHandoff {
	const statePath = join(directory, STATE_FILE);
	const acknowledgementPath = join(directory, ACKNOWLEDGEMENT_FILE);
	const timeout = options?.acknowledgementTimeoutMs ?? DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS;
	// Every borrow chains onto the last, which is what keeps two escalations that arrive
	// together from drawing over each other.
	let queue: Promise<unknown> = Promise.resolve();

	function write(state: HandoffState): void {
		try {
			writeFileSync(statePath, `${state}\n`);
		} catch {
			// A handoff we cannot request still leaves the prompt readable often enough to
			// be worth attempting; it is never worth failing the escalation over.
		}
	}

	function waitForAcknowledgement(): Promise<void> {
		return new Promise((resolve) => {
			let watcher: FSWatcher | undefined;
			let timer: NodeJS.Timeout | undefined;
			let poll: NodeJS.Timeout | undefined;
			const finish = () => {
				if (timer) clearTimeout(timer);
				if (poll) clearInterval(poll);
				watcher?.close();
				resolve();
			};
			const check = () => {
				try {
					if (readFileSync(acknowledgementPath, "utf8").trim() === "suspended") finish();
				} catch {
					// Not written yet.
				}
			};
			timer = setTimeout(finish, timeout);
			try {
				watcher = watch(directory, check);
			} catch {
				// Without a watcher the poll below still delivers, just less promptly.
			}
			poll = setInterval(check, POLL_INTERVAL_MS);
			poll.unref();
			check();
		});
	}

	async function run<T>(prompt: () => Promise<T>): Promise<T> {
		try {
			rmSync(acknowledgementPath, { force: true });
		} catch {
			// A stale acknowledgement is handled by the content check, not by its absence.
		}
		write("suspend");
		await waitForAcknowledgement();
		try {
			return await prompt();
		} finally {
			write("resume");
		}
	}

	return {
		borrowTerminal<T>(prompt: () => Promise<T>): Promise<T> {
			const next = queue.then(
				() => run(prompt),
				() => run(prompt),
			);
			// Swallowed here only so one rejected borrow does not poison the queue for the
			// next; the caller still receives the rejection through `next`.
			queue = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		},
		stop(): void {
			write("resume");
		},
	};
}

/** Child side. Acknowledges a suspend once it has actually stopped drawing and reading. */
export function observeTerminalHandoff(
	directory: string,
	hooks: { suspend: () => void | Promise<void>; resume: () => void | Promise<void> },
): { stop: () => void } {
	const statePath = join(directory, STATE_FILE);
	const acknowledgementPath = join(directory, ACKNOWLEDGEMENT_FILE);
	let current: HandoffState = "resume";
	let applying: Promise<void> = Promise.resolve();

	const apply = () => {
		let state: HandoffState | undefined;
		try {
			state = parseState(readFileSync(statePath, "utf8"));
		} catch {
			return;
		}
		if (!state || state === current) return;
		current = state;
		applying = applying.then(async () => {
			if (state === "suspend") {
				await hooks.suspend();
				try {
					writeFileSync(acknowledgementPath, "suspended\n");
				} catch {
					// The supervisor's timeout covers an acknowledgement we cannot write.
				}
			} else {
				await hooks.resume();
			}
		});
	};

	apply();

	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(directory, apply);
	} catch {
		// Without a watcher the poll below still delivers, just less promptly.
	}
	const poll = setInterval(apply, POLL_INTERVAL_MS);
	// Never hold the process open for this. The child exits on its own schedule and a
	// handoff that stops being observed at shutdown has nothing left to deliver.
	poll.unref();

	return {
		stop: () => {
			watcher?.close();
			clearInterval(poll);
		},
	};
}
