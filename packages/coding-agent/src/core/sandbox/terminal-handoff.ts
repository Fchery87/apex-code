import { closeSync, constants, type FSWatcher, openSync, readFileSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { writeWithoutFollowingLinks } from "./terminal-size.ts";

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

/**
 * Env var naming the directory holding the supervisor's command file.
 *
 * Supervisor-private where the platform backend allocates one (PS.3): the child reads the
 * suspend/resume latch there and can never write it. The acknowledgement travels the other
 * way and therefore has its own variable below.
 */
export const TERMINAL_HANDOFF_PATH_VARIABLE = "APEX_TERMINAL_HANDOFF_PATH";

/**
 * Env var naming the child-writable acknowledgement file.
 *
 * Absent means "the file next to the command file", which is the single-directory
 * arrangement the macOS backend still uses. The two locations are kept explicit rather
 * than derived because the platforms genuinely differ: Linux can put the command file on a
 * host path the child sees read-only, and macOS has no `/home` tmpfs to separate them with.
 */
export const TERMINAL_HANDOFF_ACK_PATH_VARIABLE = "APEX_TERMINAL_HANDOFF_ACK_PATH";

const STATE_FILE = "terminal-handoff";
const ACKNOWLEDGEMENT_FILE = "terminal-handoff-ack";
const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 1_000;

/**
 * Read without following a symlink at the final path component; undefined when refused.
 *
 * The acknowledgement is the one half of the handoff the contained side writes, so a link
 * planted at its path would otherwise let the child choose which host file the supervisor
 * reads. Its content is not authority (ADR 0023), but the read itself is the supervisor's.
 */
function readWithoutFollowingLinks(path: string): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		return readFileSync(descriptor, "utf8");
	} catch {
		return undefined;
	} finally {
		closeSync(descriptor);
	}
}

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

export interface TerminalHandoffOptions {
	acknowledgementTimeoutMs?: number;
	/**
	 * Where the child writes its acknowledgement. Defaults to the file beside the command
	 * file. Split from it when the command file lives somewhere the child cannot write.
	 */
	acknowledgementPath?: string;
}

/** Supervisor side. `directory` holds the command file; see the env vars above. */
export function createTerminalHandoff(directory: string, options?: TerminalHandoffOptions): TerminalHandoff {
	const statePath = join(directory, STATE_FILE);
	const acknowledgementPath = options?.acknowledgementPath ?? join(directory, ACKNOWLEDGEMENT_FILE);
	const acknowledgementDirectory = dirname(acknowledgementPath);
	// Floored at two poll intervals. The state file is a latch the child samples, so a
	// supervisor that gives up before the child can sample writes `resume` over its own
	// `suspend` and the child observes neither: it reads one value equal to what it
	// already held. Two intervals guarantee a sampling opportunity even when the
	// watcher never fires, which is the macOS case POLL_INTERVAL_MS exists for.
	const timeout = Math.max(
		options?.acknowledgementTimeoutMs ?? DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS,
		POLL_INTERVAL_MS * 2,
	);
	// Every borrow chains onto the last, which is what keeps two escalations that arrive
	// together from drawing over each other.
	let queue: Promise<unknown> = Promise.resolve();

	function write(state: HandoffState): void {
		try {
			writeWithoutFollowingLinks(statePath, `${state}\n`);
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
				// No-follow: the acknowledgement path is the one half of the handoff the child
				// may write, so a link planted there would otherwise let it choose which host
				// file the supervisor reads.
				if (readWithoutFollowingLinks(acknowledgementPath)?.trim() === "suspended") finish();
			};
			timer = setTimeout(finish, timeout);
			try {
				watcher = watch(acknowledgementDirectory, check);
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
	options?: { acknowledgementPath?: string },
): { stop: () => void } {
	const statePath = join(directory, STATE_FILE);
	const acknowledgementPath = options?.acknowledgementPath ?? join(directory, ACKNOWLEDGEMENT_FILE);
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
					writeWithoutFollowingLinks(acknowledgementPath, "suspended\n");
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
