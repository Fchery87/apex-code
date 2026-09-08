import { mkdtempSync, realpathSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temporary directory whose path is already canonical.
 *
 * `tmpdir()` is a symlink on macOS, where `/var` resolves to `/private/var`.
 * Anything under test that canonicalizes a path, which is most of this codebase
 * since ADR 0029 made the canonical target the authorized one, returns the
 * resolved form. A test that compares against the raw `mkdtemp` result then
 * passes on Linux and fails on macOS for a reason that has nothing to do with
 * what it is testing.
 */
export async function scratchDir(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export function scratchDirSync(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
