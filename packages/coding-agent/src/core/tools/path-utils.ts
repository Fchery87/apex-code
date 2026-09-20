import { randomUUID } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { FileIdentity, PreparedPathOperation } from "../permissions/operations.ts";

const NARROW_NO_BREAK_SPACE = "\u202F";

export function preparePathOperation(filePath: string, cwd: string): PreparedPathOperation {
	const canonicalPath = resolveToCwd(filePath, cwd);
	if (!isAbsolute(canonicalPath)) throw new Error("Canonical path must be absolute");
	try {
		const stats = statSync(canonicalPath);
		return {
			kind: "path-existing",
			path: { kind: "canonical-path", value: canonicalPath },
			identity: { device: stats.dev, inode: stats.ino },
		};
	} catch {
		return { kind: "path-new", path: { kind: "canonical-path", value: canonicalPath } };
	}
}

/**
 * Read the authorized target through a no-follow final-component open, verifying
 * the descriptor identity captured at authorization before any byte is returned.
 * A replaced alias or an injected symlink never matches and the read aborts.
 */
export function readPreparedPath(operation: PreparedPathOperation, maxBytes?: number): Buffer {
	if (operation.kind !== "path-existing") {
		throw new PreparedTargetChangedError("Authorized read target did not exist when permission was checked");
	}
	return withTargetDirectory(operation, { createMissingDirectories: false }, (parent, name) => {
		let fd: number;
		try {
			fd = openUnder(parent, name, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			throw new PreparedTargetChangedError("Authorized read target changed before execution", { cause: error });
		}
		try {
			const stats = fstatSync(fd);
			if (stats.dev !== operation.identity.device || stats.ino !== operation.identity.inode) {
				throw new PreparedTargetChangedError("Authorized read target changed before execution");
			}
			const length = maxBytes === undefined ? stats.size : Math.min(stats.size, maxBytes);
			const buffer = Buffer.alloc(length);
			let offset = 0;
			while (offset < buffer.length) {
				const read = readSync(fd, buffer, offset, buffer.length - offset, null);
				if (read === 0) break;
				offset += read;
			}
			return offset === buffer.length ? buffer : buffer.subarray(0, offset);
		} finally {
			closeSync(fd);
		}
	});
}

/** The authorized target changed between permission evaluation and execution. */
export class PreparedTargetChangedError extends Error {}

const PROC_FD = "/proc/self/fd";
let procFdAvailable: boolean | undefined;

/** /proc lets an already-open directory fd act as the parent of the next open, so a swapped intermediate directory cannot be traversed. */
function useProcFd(): boolean {
	if (procFdAvailable === undefined) {
		try {
			procFdAvailable = existsSync(`${PROC_FD}/self`);
		} catch {
			procFdAvailable = false;
		}
	}
	return procFdAvailable;
}

interface OpenDirectory {
	fd: number;
	/** Fallback parent path for platforms without /proc/self/fd. */
	path: string;
}

function openUnder(parent: OpenDirectory, name: string, flags: number, mode?: number): number {
	if (useProcFd()) return openSync(`${PROC_FD}/${parent.fd}/${name}`, flags, mode);
	return openSync(join(parent.path, name), flags, mode);
}

function renameUnder(parent: OpenDirectory, from: string, to: string): void {
	if (useProcFd()) renameSync(`${PROC_FD}/${parent.fd}/${from}`, `${PROC_FD}/${parent.fd}/${to}`);
	else renameSync(join(parent.path, from), join(parent.path, to));
}

function unlinkUnder(parent: OpenDirectory, name: string): void {
	try {
		if (useProcFd()) unlinkSync(`${PROC_FD}/${parent.fd}/${name}`);
		else unlinkSync(join(parent.path, name));
	} catch {}
}

/**
 * The name of the sibling a publish stages into.
 *
 * It carries enough of the destination to be recognizable if a crash ever strands one, and
 * a pid and a random suffix so two publishes in one directory cannot collide. The base is
 * truncated to fit: a destination already at the filesystem's per-component limit would
 * otherwise produce a staging name past it, and fail a write that truncate-in-place handled.
 * 255 is the limit on every filesystem this runs on that has one at all.
 */
function stagingName(name: string): string {
	const suffix = `.apex-${process.pid}-${randomUUID().slice(0, 8)}`;
	const budget = 255 - suffix.length - 1;
	return `.${name.slice(0, Math.max(1, budget))}${suffix}`;
}

/**
 * Write `content` to a sibling of `name` and rename it over `name`.
 *
 * The rename is the publish. Until it runs, `name` still refers to the old inode with all
 * of its old bytes, so a crash, a full disk, or a kill mid-write destroys nothing. The
 * caller has already proved that `name` refers to the authorized target; this only decides
 * how the bytes arrive.
 *
 * `mode` is the destination's, captured from the descriptor the identity check used, so a
 * publish does not quietly reset a file's permissions to the temp file's. Ownership is not
 * carried: a rename installs a file this process created, so a target owned by someone else
 * and merely writable by us changes owner. That is inherent to publishing by rename and is
 * the same trade the session store already makes.
 *
 * One guarantee narrows, and it is worth stating plainly rather than leaving for a reader to
 * derive. ADR 0029's identity check still runs and still aborts on a mismatch, but it now
 * proves the name referred to the authorized file at the moment of the check rather than at
 * the moment of the write. Writing through the checked descriptor could not be redirected by
 * a later swap; a rename can be, because it resolves the name again. The window is between
 * the identity check and the rename, both anchored to the same validated parent descriptor,
 * and exploiting it needs a local attacker placing a file at that exact name in a directory
 * the call was already authorized to write. That is traded for crash safety, which is not a
 * race: it is what every interrupted write did.
 *
 * Windows refuses a rename onto a destination another handle holds open, and an ordinary read
 * handle is enough to trigger it. An earlier version of this comment called that an acceptable
 * trade. Three-OS CI disproved it: the case is an editor, a watcher, or a language server with
 * the file open, which is the common case rather than an exotic one, and failing the write
 * there is not a trade a user opted into. It falls back to `writeInPlace` instead, so Windows
 * gets atomic publish whenever it can and a working write when it cannot.
 */
function publishByRename(parent: OpenDirectory, name: string, content: string | Buffer, mode: number): boolean {
	const temporary = stagingName(name);
	let fd: number;
	try {
		fd = openUnder(
			parent,
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			mode,
		);
	} catch (error) {
		throw new PreparedTargetChangedError("Authorized write could not stage its replacement", { cause: error });
	}
	try {
		writeAll(fd, content);
		// The create mode passes through umask; the destination's mode does not.
		fchmodSync(fd, mode);
		closeSync(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {}
		unlinkUnder(parent, temporary);
		throw error;
	}
	try {
		renameUnder(parent, temporary, name);
		return true;
	} catch (error) {
		unlinkUnder(parent, temporary);
		if (isWindowsSharingViolation(error)) return false;
		throw new PreparedTargetChangedError("Authorized write target changed before execution", { cause: error });
	}
}

/**
 * Windows refuses to rename onto a destination another handle holds open, and an ordinary
 * read handle is enough. An editor, a watcher, or a language server with the file open is
 * the common case, not an exotic one, so a rename that cannot land there has to fall back
 * rather than fail the write.
 *
 * Three OS CI found this. The Linux and macOS jobs pass, because POSIX renames over an open
 * file happily.
 */
function isWindowsSharingViolation(error: unknown): boolean {
	if (process.platform !== "win32") return false;
	const code = (error as { code?: unknown } | null)?.code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/**
 * The pre-rename publish, kept for the one case that cannot use a rename.
 *
 * This is the truncate-then-write window the rename exists to close, so it runs only when
 * Windows has refused the rename. Crash safety is lost for that write; the alternative is
 * refusing to write a file something else has open, which is worse and is not a trade a
 * user opted into. The identity check is re-run against a freshly opened descriptor, so the
 * weaker durability does not come with a weaker target guarantee.
 */
function writeInPlace(parent: OpenDirectory, name: string, content: string | Buffer, identity?: FileIdentity): void {
	let fd: number;
	try {
		fd = openUnder(parent, name, constants.O_WRONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new PreparedTargetChangedError("Authorized write target changed before execution", { cause: error });
	}
	try {
		if (identity) {
			const stats = fstatSync(fd);
			if (stats.dev !== identity.device || stats.ino !== identity.inode) {
				throw new PreparedTargetChangedError("Authorized write target changed before execution");
			}
		}
		ftruncateSync(fd, 0);
		writeAll(fd, content);
	} finally {
		closeSync(fd);
	}
}

function mkdirUnder(parent: OpenDirectory, name: string): void {
	if (useProcFd()) mkdirSync(`${PROC_FD}/${parent.fd}/${name}`);
	else mkdirSync(join(parent.path, name));
}

function openChildDirectory(parent: OpenDirectory, name: string): OpenDirectory {
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	const fd = openUnder(parent, name, flags);
	closeSync(parent.fd);
	return { fd, path: join(parent.path, name) };
}

function writeAll(fd: number, content: string | Buffer): void {
	const buffer = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
	let written = 0;
	while (written < buffer.length) {
		written += writeSync(fd, buffer, written, buffer.length - written);
	}
}

function isMissingEntryError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Walk every directory component of the authorized path no-follow, holding one
 * directory fd across the walk, then run the caller's final-component step against
 * that walked parent. Any intermediate that is not a real directory — a swapped
 * symlink, a removed component — aborts before the target is touched.
 */
function withTargetDirectory<T>(
	operation: PreparedPathOperation,
	options: { createMissingDirectories: boolean },
	run: (parent: OpenDirectory, name: string) => T,
): T {
	const root = parse(operation.path.value).root;
	const components = operation.path.value
		.slice(root.length)
		.split(sep)
		.filter((component) => component.length > 0);
	const name = components[components.length - 1];
	if (name === undefined) throw new PreparedTargetChangedError("Authorized path has no final component");
	let parent: OpenDirectory = { fd: openSync(root, constants.O_RDONLY | constants.O_DIRECTORY), path: root };
	const closeParent = (): void => {
		try {
			closeSync(parent.fd);
		} catch {}
	};
	for (const component of components.slice(0, -1)) {
		try {
			parent = openChildDirectory(parent, component);
		} catch (error) {
			if (options.createMissingDirectories && isMissingEntryError(error)) {
				try {
					mkdirUnder(parent, component);
					parent = openChildDirectory(parent, component);
					continue;
				} catch (mkdirError) {
					closeParent();
					throw new PreparedTargetChangedError(`Authorized write parent "${component}" changed before execution`, {
						cause: mkdirError,
					});
				}
			}
			closeParent();
			throw new PreparedTargetChangedError(`Authorized path component "${component}" changed before execution`, {
				cause: error,
			});
		}
	}
	try {
		return run(parent, name);
	} finally {
		closeParent();
	}
}

/**
 * Execute an authorized write against the prepared target.
 *
 * - `path-existing`: the final component is opened `O_NOFOLLOW`, its descriptor
 *   identity is compared with the identity captured at authorization, and only
 *   then is the file truncated and written through that descriptor. A swapped
 *   alias, an injected symlink, or a redirected parent never matches and the
 *   write aborts before any byte changes.
 * - `path-new`: missing parents are created no-follow under the walked directory
 *   descriptor, and the file is created `O_CREAT | O_EXCL | O_NOFOLLOW`, so a
 *   replaced parent or a pre-placed symlink is never followed.
 */
export function writePreparedPath(operation: PreparedPathOperation, content: string | Buffer): void {
	withTargetDirectory(operation, { createMissingDirectories: operation.kind === "path-new" }, (parent, name) => {
		if (operation.kind === "path-existing") {
			let fd: number;
			try {
				fd = openUnder(parent, name, constants.O_WRONLY | constants.O_NOFOLLOW);
			} catch (error) {
				throw new PreparedTargetChangedError("Authorized write target changed before execution", { cause: error });
			}
			let mode: number;
			try {
				const stats = fstatSync(fd);
				if (stats.dev !== operation.identity.device || stats.ino !== operation.identity.inode) {
					throw new PreparedTargetChangedError("Authorized write target changed before execution");
				}
				mode = stats.mode & 0o7777;
			} finally {
				closeSync(fd);
			}
			if (!publishByRename(parent, name, content, mode)) {
				writeInPlace(parent, name, content, operation.identity);
			}
			return;
		}
		// The exclusive create is what proves the name was still absent, which is the whole
		// authorization for a new-file write. It reserves the name; the rename below then
		// replaces that empty placeholder, so the name never holds a half-written file.
		let fd: number;
		try {
			fd = openUnder(
				parent,
				name,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			throw new PreparedTargetChangedError("Authorized new-file target changed before execution", { cause: error });
		}
		closeSync(fd);
		try {
			// The reservation this just created is ours, so there is no prior identity to
			// re-check if Windows refuses the rename onto it.
			if (!publishByRename(parent, name, content, 0o600)) {
				writeInPlace(parent, name, content);
			}
		} catch (error) {
			unlinkUnder(parent, name);
			throw error;
		}
	});
}

/**
 * Atomic publish for an ungated write, where no prepared operation exists to pin the target.
 *
 * `writePreparedPath` is the gated path and the one that matters; this is its counterpart for
 * a tool invoked outside the permission gate, so that neither route can leave a half-written
 * file. It makes no containment claim: with no authorization there is no authorized target to
 * hold the write to, and the no-follow walk would have nothing to check against.
 */
export function writePathAtomically(filePath: string, content: string | Buffer): void {
	const temporary = join(dirname(filePath), stagingName(basename(filePath)));
	// Only an existing destination has a mode worth carrying. For a new file there is
	// nothing to capture, and chmod'ing to the 0o666 open default would force past the
	// caller's umask and publish a world-writable file, which `writeFile` never did.
	let destinationMode: number | undefined;
	try {
		destinationMode = statSync(filePath).mode & 0o7777;
	} catch {}
	const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, destinationMode ?? 0o666);
	try {
		writeAll(fd, content);
		if (destinationMode !== undefined) fchmodSync(fd, destinationMode);
		closeSync(fd);
	} catch (error) {
		try {
			closeSync(fd);
		} catch {}
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
	try {
		renameSync(temporary, filePath);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		// Same Windows sharing case as the gated path, and the same answer: a file something
		// else has open is still a file the caller asked to write.
		if (!isWindowsSharingViolation(error)) throw error;
		const fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT, destinationMode ?? 0o666);
		try {
			ftruncateSync(fd, 0);
			writeAll(fd, content);
		} finally {
			closeSync(fd);
		}
	}
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd, handling ~ expansion and absolute
 * paths. The result is the single target used by both permission matching and
 * filesystem execution.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	const requested = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
	try {
		return realpathSync(requested);
	} catch {
		try {
			return joinCanonicalParent(requested);
		} catch {
			return requested;
		}
	}
}

function joinCanonicalParent(requested: string): string {
	return join(realpathSync(dirname(requested)), basename(requested));
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// Try macOS AM/PM variant (narrow no-break space before AM/PM)
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// Try NFD variant (macOS stores filenames in NFD form)
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// Try curly quote variant (macOS uses U+2019 in screenshot names)
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
