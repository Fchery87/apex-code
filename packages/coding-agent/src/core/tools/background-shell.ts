import { randomUUID } from "node:crypto";
import { killProcessTree } from "../../utils/shell.ts";
import type { CommandJournalRecorder } from "../durable-state/command-journal.ts";
import type { OutputAccumulator } from "./output-accumulator.ts";

/**
 * The background-shell registry (spec 2026-08-31-background-shell.md): handles
 * for `bash` commands launched with `background: true`, mirroring delegation's
 * recorded lifetime rule -- entries live for their registry's lifetime, which
 * is the session's, and `dispose` kills everything still running so no child
 * outlives the session that launched it.
 */

export interface BackgroundShellLaunch {
	command: string;
	pid?: number;
	output: OutputAccumulator;
	exited: Promise<number | null>;
	/** The journal record begun before the process started, so its outcome can be recorded. */
	journalId?: string;
}

export interface BackgroundShellRegistryOptions {
	readonly journal?: CommandJournalRecorder;
}

export interface BackgroundShellStatus {
	handle: string;
	command: string;
	startedAt: number;
	running: boolean;
	killed: boolean;
	exitCode?: number | null;
}

export interface BackgroundShellRetrieval {
	status: BackgroundShellStatus;
	snapshot: ReturnType<OutputAccumulator["snapshot"]>;
}

interface Entry extends BackgroundShellStatus {
	pid?: number;
	output: OutputAccumulator;
	finalized: boolean;
}

export class BackgroundShellRegistry {
	readonly #entries = new Map<string, Entry>();
	readonly #journal: CommandJournalRecorder | undefined;

	constructor(options: BackgroundShellRegistryOptions = {}) {
		this.#journal = options.journal;
	}

	/**
	 * Records a background command as running before its process is started. Throws when the
	 * journal cannot record it, so the caller refuses to start the command instead of running
	 * it unrecorded. Returns undefined when no journal is configured.
	 */
	beginJournal(command: string): string | undefined {
		return this.#journal?.begin(command);
	}

	/** Records a journaled command whose process never started. */
	failJournal(id: string, error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		this.#journal?.fail(id, `launch failed: ${reason}`);
	}

	launch(input: BackgroundShellLaunch): string {
		const handle = randomUUID();
		const entry: Entry = {
			handle,
			command: input.command,
			startedAt: Date.now(),
			pid: input.pid,
			killed: false,
			running: true,
			output: input.output,
			finalized: false,
		};
		this.#entries.set(handle, entry);
		const recordOutcome = (exitCode: number | null) => {
			if (input.journalId !== undefined) {
				this.#journal?.finish(input.journalId, { exitCode, killed: entry.killed });
			}
		};
		void input.exited.then(
			(code) => {
				entry.running = false;
				entry.exitCode = code;
				recordOutcome(code);
			},
			() => {
				entry.running = false;
				entry.exitCode = null;
				recordOutcome(null);
			},
		);
		return handle;
	}

	status(handle: string): BackgroundShellStatus | undefined {
		const entry = this.#entries.get(handle);
		if (!entry) return undefined;
		const { output: _output, finalized: _finalized, ...status } = entry;
		return status;
	}

	async retrieve(handle: string): Promise<BackgroundShellRetrieval | undefined> {
		const entry = this.#entries.get(handle);
		if (!entry) return undefined;
		if (!entry.running && !entry.finalized) {
			entry.output.finish();
			try {
				await entry.output.closeTempFile();
			} catch {
				// Already closed by a concurrent retrieval; the snapshot below is still valid.
			}
			entry.finalized = true;
		}
		return { status: this.status(handle)!, snapshot: entry.output.snapshot({ persistIfTruncated: true }) };
	}

	kill(handle: string): BackgroundShellStatus | undefined {
		const entry = this.#entries.get(handle);
		if (!entry) return undefined;
		if (entry.running) {
			entry.killed = true;
			if (entry.pid) killProcessTree(entry.pid);
		}
		return this.status(handle);
	}

	dispose(): void {
		for (const entry of this.#entries.values()) {
			if (entry.running) {
				entry.killed = true;
				if (entry.pid) killProcessTree(entry.pid);
			}
		}
	}

	handles(): string[] {
		return [...this.#entries.keys()];
	}

	/** Evidence support: resolve a handle back to the command that produced the output. */
	commandFor(handle: string): string | undefined {
		return this.#entries.get(handle)?.command;
	}
}

export function createBackgroundShellRegistry(options: BackgroundShellRegistryOptions = {}): BackgroundShellRegistry {
	return new BackgroundShellRegistry(options);
}
