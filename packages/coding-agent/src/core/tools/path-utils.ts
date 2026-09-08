import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
	writeSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { PreparedPathOperation } from "../permissions/operations.ts";

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
			try {
				const stats = fstatSync(fd);
				if (stats.dev !== operation.identity.device || stats.ino !== operation.identity.inode) {
					throw new PreparedTargetChangedError("Authorized write target changed before execution");
				}
				ftruncateSync(fd, 0);
				writeAll(fd, content);
			} finally {
				closeSync(fd);
			}
			return;
		}
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
		try {
			writeAll(fd, content);
		} finally {
			closeSync(fd);
		}
	});
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
