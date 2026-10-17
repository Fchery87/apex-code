/**
 * What the model has read in this session, per file (HR.24). `write` and `edit` consult it so
 * a replacement is never made against a file the model has not seen, or has seen only in part,
 * or that changed on disk since it was read.
 *
 * In memory and per session. A resumed session starts empty, so the first write after a resume
 * asks the model to read the file again. That is intended.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

interface LedgerEntry {
	hash: string;
	/** True when the whole file was read, not a range or a truncated part of it. */
	complete: boolean;
}

function hashOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export class FileReadLedger {
	private readonly entries = new Map<string, LedgerEntry>();

	recordRead(path: string, content: string, complete: boolean): void {
		this.entries.set(path, { hash: hashOf(content), complete });
	}

	/** After a successful write or edit the model knows the file's full new content. */
	recordWrite(path: string, content: string): void {
		this.entries.set(path, { hash: hashOf(content), complete: true });
	}

	/**
	 * Why a replacement must be refused, or undefined when it may proceed. `current` is the file
	 * as it is on disk now, or undefined when it does not exist (a new file needs no read).
	 */
	checkWrite(path: string, current: string | undefined): string | undefined {
		if (current === undefined) return undefined;
		const entry = this.entries.get(path);
		if (!entry) {
			return "the file exists and has not been read in this session. Read it before replacing it.";
		}
		if (entry.hash !== hashOf(current)) {
			return "the file changed on disk since you read it. Read it again before changing it.";
		}
		if (!entry.complete) {
			return "only part of the file was read. Read the whole file before replacing it with write.";
		}
		return undefined;
	}

	/** `edit` needs only that the file has not changed since the model last read it. */
	checkEdit(path: string, current: string | undefined): string | undefined {
		if (current === undefined) return undefined;
		const entry = this.entries.get(path);
		if (entry && entry.hash !== hashOf(current)) {
			return "the file changed on disk since you read it. Read it again before editing it.";
		}
		return undefined;
	}
}

/** The file's text as it is on disk now, or undefined when it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path)).toString("utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
