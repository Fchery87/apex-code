import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPreparedPath, writePreparedPath } from "../src/core/tools/path-utils.ts";

const fixture = vi.hoisted(() => ({ directory: "", root: "" }));

vi.mock("node:path", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:path")>();
	return { ...actual.win32, default: actual.win32 };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const path = await vi.importActual<typeof import("node:path")>("node:path");
	function hostPath(value: string): string {
		if (!value.startsWith(fixture.root)) {
			throw Object.assign(new Error(`Unexpected Windows path ${value}`), { code: "ENOENT" });
		}
		return path.join(fixture.directory, ...value.slice(fixture.root.length).split("\\"));
	}
	return {
		...actual,
		existsSync: (value: string) => (value === "/proc/self/fd/self" ? false : actual.existsSync(hostPath(value))),
		openSync: (value: string, flags: number, mode?: number) => actual.openSync(hostPath(value), flags, mode),
		mkdirSync: (value: string) => actual.mkdirSync(hostPath(value)),
	};
});

describe.each(["C:\\", "\\\\server\\share\\", "\\\\?\\C:\\"])("prepared path execution under %s", (root) => {
	beforeEach(() => {
		fixture.directory = mkdtempSync(`${tmpdir()}/apex-windows-path-`);
		fixture.root = root;
	});

	afterEach(() => rmSync(fixture.directory, { recursive: true, force: true }));

	it("reads and overwrites the authorized existing file", () => {
		const file = `${fixture.directory}/existing.txt`;
		writeFileSync(file, "before");
		const stats = statSync(file);
		const operation = {
			kind: "path-existing" as const,
			path: { kind: "canonical-path" as const, value: `${root}existing.txt` },
			identity: { device: stats.dev, inode: stats.ino },
		};
		expect(readPreparedPath(operation).toString()).toBe("before");
		writePreparedPath(operation, "after");
		expect(readFileSync(file, "utf8")).toBe("after");
	});

	it("creates missing parents and a new file beneath the authorized root", () => {
		writePreparedPath(
			{
				kind: "path-new",
				path: { kind: "canonical-path", value: `${root}nested\\new.txt` },
			},
			"created",
		);
		expect(readFileSync(`${fixture.directory}/nested/new.txt`, "utf8")).toBe("created");
	});
});
