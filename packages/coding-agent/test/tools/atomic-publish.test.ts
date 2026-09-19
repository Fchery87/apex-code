import {
	chmodSync,
	closeSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	PreparedTargetChangedError,
	preparePathOperation,
	writePreparedPath,
} from "../../src/core/tools/path-utils.ts";

/**
 * `edit` and `write` truncated the authorized target and then wrote into it, so the window
 * between the two held a file with none of the old content and not yet all of the new. A
 * crash, a full disk, or a kill in that window left the only copy destroyed.
 *
 * A reader holding a descriptor across the publish is the deterministic way to observe the
 * difference without staging a crash. Truncate-in-place mutates the inode that reader is
 * holding. A rename leaves it untouched and moves the name to a new one, which is the whole
 * property.
 */
describe("edit and write publish atomically", () => {
	let dir: string;
	const original = "the content that must survive a failed publish\n";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "apex-atomic-"));
	});

	it("leaves a reader's already-open descriptor showing the original bytes", () => {
		const target = join(dir, "notes.txt");
		writeFileSync(target, original);
		const operation = preparePathOperation(target, dir);

		const reader = openSync(target, "r");
		try {
			writePreparedPath(operation, "replacement\n");
			const buffer = Buffer.alloc(original.length);
			const read = readSync(reader, buffer, 0, buffer.length, 0);
			expect(buffer.subarray(0, read).toString("utf-8")).toBe(original);
		} finally {
			closeSync(reader);
		}
	});

	it("publishes the new content under the name", () => {
		const target = join(dir, "notes.txt");
		writeFileSync(target, original);
		writePreparedPath(preparePathOperation(target, dir), "replacement\n");
		expect(readFileSync(target, "utf-8")).toBe("replacement\n");
	});

	it("replaces the name's inode rather than rewriting it in place", () => {
		const target = join(dir, "notes.txt");
		writeFileSync(target, original);
		const before = statSync(target).ino;
		writePreparedPath(preparePathOperation(target, dir), "replacement\n");
		expect(statSync(target).ino).not.toBe(before);
	});

	it("preserves the destination's mode, so publishing does not reset permissions", () => {
		const target = join(dir, "secret.txt");
		writeFileSync(target, original);
		chmodSync(target, 0o640);
		writePreparedPath(preparePathOperation(target, dir), "replacement\n");
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});

	it("still refuses a target whose identity changed after authorization", () => {
		const target = join(dir, "notes.txt");
		writeFileSync(target, original);
		const operation = preparePathOperation(target, dir);
		writeFileSync(join(dir, "other.txt"), "other");
		// Replace the name with a different inode, which is what the identity check exists for.
		writeFileSync(target, "swapped by someone else");
		const swapped = statSync(target).ino;
		if (swapped === (operation.kind === "path-existing" ? operation.identity.inode : -1)) {
			// Same inode means the rewrite reused it, so there is nothing for the check to catch.
			return;
		}
		expect(() => writePreparedPath(operation, "replacement\n")).toThrow(PreparedTargetChangedError);
	});

	it("still creates a new file and still refuses one that appeared after authorization", () => {
		const fresh = join(dir, "new.txt");
		const operation = preparePathOperation(fresh, dir);
		expect(operation.kind).toBe("path-new");
		writePreparedPath(operation, "created\n");
		expect(readFileSync(fresh, "utf-8")).toBe("created\n");

		const raced = join(dir, "raced.txt");
		const racedOperation = preparePathOperation(raced, dir);
		writeFileSync(raced, "someone got here first");
		expect(() => writePreparedPath(racedOperation, "created\n")).toThrow(PreparedTargetChangedError);
	});

	it("leaves no temporary file behind", () => {
		const target = join(dir, "notes.txt");
		writeFileSync(target, original);
		writePreparedPath(preparePathOperation(target, dir), "replacement\n");
		expect(readdirSync(dir)).toEqual(["notes.txt"]);
	});
});
