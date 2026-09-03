import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	DEFAULT_WORKSPACE_MAX_ARTIFACTS,
	DEFAULT_WORKSPACE_MAX_PATCH_BYTES,
	DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
} from "../settings-manager.ts";

/**
 * Durable workspace artifact store (WS.3, spec
 * 2026-09-01-harness-correctness-and-workspace-state.md § 2).
 *
 * This is the named owner for workspace-state artifacts. It is scoped to one
 * session file (`<basename>.artifacts/workspace-state/` next to the session
 * JSONL) and guarantees:
 *
 * - atomic publish (unique temp file in the target directory, `rename(2)`,
 *   hash verified after publish; interrupted writes leave only `.tmp` files
 *   that are ignored and cleaned up by the next write);
 * - restrictive permissions (directory 0o700, files 0o600 on platforms that
 *   enforce them);
 * - integrity (sha256 + byte length in the reference; a mismatch reads as
 *   `integrity` failure, never as bytes);
 * - bounded retention (FIFO by count and by total bytes; `.tmp` leftovers do
 *   not count);
 * - permission-gated retrieval (the caller must pass an explicit permission
 *   decision; a denied read never probes the filesystem, so denial leaks no
 *   existence oracle).
 *
 * Artifact references confer no permission by themselves: content reaches a
 * provider or a tool only through the normal permission system and output
 * bounds at the consuming surface. Patch bytes never enter the session JSONL
 * or the evidence ledger.
 */

const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TMP_SUFFIX = ".tmp";

export interface WorkspaceArtifactRef {
	artifactId: string;
	/** File name inside the store directory; never a path with separators. */
	file: string;
	sha256: string;
	bytes: number;
}

export type WorkspaceArtifactPermission =
	| {
			allowed: true;
	  }
	| {
			allowed: false;
			reason: string;
	  };

export type WorkspaceArtifactRead =
	| { ok: true; bytes: Buffer }
	| { ok: false; reason: "denied" | "missing" | "integrity" | "invalid-ref" };

export interface WriteArtifactOptions {
	/** Reject payloads larger than this (default: settings default). */
	maxBytes?: number;
	/** Retention count cap applied after the write (default: settings default). */
	maxArtifacts?: number;
	/** Retention total-bytes cap applied after the write (default: settings default). */
	maxTotalBytes?: number;
	signal?: AbortSignal;
}

export interface StoredArtifactInfo {
	file: string;
	bytes: number;
}

/** `<dir>/<session-basename>.artifacts/workspace-state` next to a session file. */
export function workspaceArtifactDirFor(sessionFile: string): string {
	const base = basename(sessionFile).replace(/\.jsonl$/, "");
	return join(dirname(sessionFile), `${base}.artifacts`, "workspace-state");
}

function sha256Hex(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class WorkspaceArtifactStore {
	readonly dir: string;
	#counter = 0;

	constructor(sessionFile: string) {
		this.dir = workspaceArtifactDirFor(sessionFile);
	}

	#validFileName(file: string): boolean {
		return FILE_PATTERN.test(file) && !file.endsWith(TMP_SUFFIX) && !file.includes("..");
	}

	#listStored(): StoredArtifactInfo[] {
		if (!existsSync(this.dir)) return [];
		const stored: StoredArtifactInfo[] = [];
		for (const file of readdirSync(this.dir)) {
			if (!this.#validFileName(file)) continue;
			const full = join(this.dir, file);
			const stat = statSync(full);
			if (!stat.isFile()) continue;
			stored.push({ file, bytes: stat.size });
		}
		// File names embed a sortable write sequence
		// (`<time>-<counter>-<artifactId>.patch`), so lexicographic order is
		// chronological regardless of filesystem timestamp granularity.
		stored.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
		return stored;
	}

	#removeStaleTemp(): void {
		if (!existsSync(this.dir)) return;
		for (const file of readdirSync(this.dir)) {
			if (file.endsWith(TMP_SUFFIX)) {
				try {
					unlinkSync(join(this.dir, file));
				} catch {
					// A concurrent writer owns it; leave it for the next pass.
				}
			}
		}
	}

	#prune(maxArtifacts: number, maxTotalBytes: number): void {
		const stored = this.#listStored();
		let total = stored.reduce((sum, info) => sum + info.bytes, 0);
		let excessCount = stored.length - maxArtifacts;
		for (const info of stored) {
			if (excessCount <= 0 && total <= maxTotalBytes) break;
			if (excessCount > 0 || total > maxTotalBytes) {
				try {
					rmSync(join(this.dir, info.file), { force: true });
					total -= info.bytes;
					excessCount--;
				} catch {
					// Unlinkable now; the next write retries.
				}
			}
		}
	}

	async writeArtifact(bytes: Buffer, options?: WriteArtifactOptions): Promise<WorkspaceArtifactRef> {
		if (options?.signal?.aborted) {
			throw new Error("workspace artifact write cancelled");
		}
		const maxBytes = options?.maxBytes ?? DEFAULT_WORKSPACE_MAX_PATCH_BYTES;
		if (bytes.byteLength > maxBytes) {
			throw new Error(`workspace artifact exceeds the configured cap (${bytes.byteLength} > ${maxBytes} bytes)`);
		}
		const maxArtifacts = options?.maxArtifacts ?? DEFAULT_WORKSPACE_MAX_ARTIFACTS;
		const maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_WORKSPACE_MAX_TOTAL_BYTES;

		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		this.#removeStaleTemp();

		const artifactId = randomUUID();
		const sequence = `${Date.now().toString(36).padStart(8, "0")}-${(this.#counter++).toString(36).padStart(4, "0")}`;
		const file = `${sequence}-${artifactId}.patch`;
		const finalPath = join(this.dir, file);
		const tempPath = join(this.dir, `${artifactId}${TMP_SUFFIX}`);
		const expected = sha256Hex(bytes);
		writeFileSync(tempPath, bytes, { mode: 0o600 });
		// Atomic publish: readers only ever see the final name.
		renameSync(tempPath, finalPath);
		// Integrity check on our own publish path: a silent corruption or a
		// truncating filesystem must not leave a reference that reads back
		// different bytes.
		const written = readFileSync(finalPath);
		if (sha256Hex(written) !== expected || written.byteLength !== bytes.byteLength) {
			rmSync(finalPath, { force: true });
			throw new Error("workspace artifact failed its post-publish integrity check");
		}

		this.#prune(maxArtifacts, maxTotalBytes);
		return { artifactId, file, sha256: expected, bytes: bytes.byteLength };
	}

	async readArtifact(
		ref: WorkspaceArtifactRef,
		permission: WorkspaceArtifactPermission,
	): Promise<WorkspaceArtifactRead> {
		// Permission is checked before any filesystem access so denial cannot
		// leak existence through a missing-vs-present distinction.
		if (!permission.allowed) {
			return { ok: false, reason: "denied" };
		}
		if (typeof ref?.file !== "string" || !this.#validFileName(ref.file)) {
			return { ok: false, reason: "invalid-ref" };
		}
		const full = join(this.dir, ref.file);
		let bytes: Buffer;
		try {
			if (!existsSync(full)) return { ok: false, reason: "missing" };
			bytes = readFileSync(full);
		} catch {
			return { ok: false, reason: "missing" };
		}
		if (bytes.byteLength !== ref.bytes || sha256Hex(bytes) !== ref.sha256) {
			return { ok: false, reason: "integrity" };
		}
		return { ok: true, bytes };
	}

	listArtifactsSync(): StoredArtifactInfo[] {
		return this.#listStored();
	}

	async removeAll(): Promise<void> {
		rmSync(this.dir, { recursive: true, force: true });
	}
}
