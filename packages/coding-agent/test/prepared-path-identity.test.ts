import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePathOperation, readPreparedPath, writePreparedPath } from "../src/core/tools/path-utils.ts";

const control = vi.hoisted(() => ({ reportZeroInode: false }));

// Windows reports a zero inode when the file index is unavailable for a handle, and POSIX
// reserves inode 0 for "no file". Neither can be produced on demand from a real file, so the
// platform's answer is forced here and nothing else about the filesystem is faked.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const zero = (stats: import("node:fs").Stats) => {
		if (control.reportZeroInode) Object.defineProperty(stats, "ino", { value: 0, configurable: true });
		return stats;
	};
	return {
		...actual,
		statSync: (target: never, options?: never) => zero(actual.statSync(target, options)),
		fstatSync: (fd: never, options?: never) => zero(actual.fstatSync(fd, options)),
	};
});

describe("prepared path execution when the platform cannot report an inode", () => {
	let directory = "";

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "apex-identity-"));
		control.reportZeroInode = false;
	});

	afterEach(() => {
		control.reportZeroInode = false;
		rmSync(directory, { recursive: true, force: true });
	});

	it("refuses a read it cannot hold to an identity", () => {
		const file = join(directory, "secret.txt");
		writeFileSync(file, "secret");
		control.reportZeroInode = true;
		const operation = preparePathOperation("secret.txt", directory);

		expect(() => readPreparedPath(operation)).toThrow(/identity/i);
	});

	it("refuses a write it cannot hold to an identity, leaving the file untouched", () => {
		const file = join(directory, "target.txt");
		writeFileSync(file, "original");
		control.reportZeroInode = true;
		const operation = preparePathOperation("target.txt", directory);

		expect(() => writePreparedPath(operation, "attacker")).toThrow(/identity/i);
		expect(readFileSync(file, "utf8")).toBe("original");
	});

	it("still reads and writes normally when the platform reports a real inode", () => {
		const file = join(directory, "ordinary.txt");
		writeFileSync(file, "before");
		const operation = preparePathOperation("ordinary.txt", directory);

		expect(readPreparedPath(operation).toString()).toBe("before");
		writePreparedPath(operation, "after");
		expect(readFileSync(file, "utf8")).toBe("after");
	});

	it("still creates a new file, which has no prior identity to verify", () => {
		control.reportZeroInode = true;
		const operation = preparePathOperation("fresh.txt", directory);

		expect(operation.kind).toBe("path-new");
		writePreparedPath(operation, "created");
		expect(readFileSync(join(directory, "fresh.txt"), "utf8")).toBe("created");
	});
});
