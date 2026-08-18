import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getToolPath,
	installManagedToolArchive,
	resolveHostToolBinary,
	resolveManagedToolArtifact,
} from "../src/utils/tools-manager.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "apex-managed-tool-"));
	directories.push(directory);
	return directory;
}

describe("managed executable artifacts", () => {
	it("uses reviewed pinned metadata rather than a mutable latest-release lookup", () => {
		const artifact = resolveManagedToolArtifact({ tool: "rg", platform: "linux", architecture: "x64" });
		expect(artifact.version).toBe("14.1.1");
		expect(artifact.url).toContain("/releases/download/14.1.1/");
		expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(artifact.maxBytes).toBeGreaterThan(artifact.expectedBytes);
	});

	it("rejects a digest mismatch without promoting an executable", async () => {
		const destination = await temporaryDirectory();
		const archive = join(destination, "tool.tar.gz");
		await writeFile(archive, "tampered archive");
		const expectedSha256 = createHash("sha256").update("known-good archive").digest("hex");

		await expect(
			installManagedToolArchive({
				archivePath: archive,
				destination,
				binaryName: "rg",
				archiveKind: "tar.gz",
				expectedSha256,
				maxBytes: 1024,
			}),
		).rejects.toThrow("digest mismatch");
		await expect(readFile(join(destination, "rg"))).rejects.toThrow();
	});

	it("rejects an oversized archive without extracting it", async () => {
		const destination = await temporaryDirectory();
		const archive = join(destination, "tool.tar.gz");
		const content = "x".repeat(2048);
		await writeFile(archive, content);
		const expectedSha256 = createHash("sha256").update(content).digest("hex");

		await expect(
			installManagedToolArchive({
				archivePath: archive,
				destination,
				binaryName: "rg",
				archiveKind: "tar.gz",
				expectedSha256,
				maxBytes: 1024,
			}),
		).rejects.toThrow("bounded limit");
		await expect(readFile(join(destination, "rg"))).rejects.toThrow();
	});

	it("throws for a platform/architecture combination with no reviewed pin", () => {
		expect(() => resolveManagedToolArtifact({ tool: "rg", platform: "win32", architecture: "arm64" })).toThrow(
			/no reviewed pinned artifact/i,
		);
	});

	it("verifies, quarantines, and atomically promotes a real archive to an executable binary", async () => {
		const destination = await temporaryDirectory();
		const stagingDirectory = await temporaryDirectory();
		// installManagedToolArchive looks for "<binaryName>.exe" on Windows and
		// "<binaryName>" everywhere else -- the archive fixture must match
		// whichever this test is actually running under.
		const binaryFileName = process.platform === "win32" ? "rg.exe" : "rg";
		const binarySource = join(stagingDirectory, binaryFileName);
		writeFileSync(binarySource, "#!/bin/sh\necho fake-rg\n");
		const archive = join(stagingDirectory, "tool.tar.gz");
		execFileSync("tar", ["czf", archive, "-C", stagingDirectory, binaryFileName]);
		const expectedSha256 = createHash("sha256")
			.update(await readFile(archive))
			.digest("hex");

		const installedPath = await installManagedToolArchive({
			archivePath: archive,
			destination,
			binaryName: "rg",
			archiveKind: "tar.gz",
			expectedSha256,
			maxBytes: 1_000_000,
		});

		expect(installedPath).toBe(join(destination, binaryFileName));
		expect((await readFile(installedPath, "utf8")).trim()).toBe("#!/bin/sh\necho fake-rg");
		// chmod is a no-op on Windows (tools-manager.ts skips it there; POSIX
		// mode bits don't represent Windows ACL-based permissions).
		if (process.platform !== "win32") {
			expect(statSync(installedPath).mode & 0o777).toBe(0o755);
		}
		// No quarantine directory survives a successful install.
		const entries = await readdir(destination);
		expect(entries).toEqual([binaryFileName]);
	});
});

// A sandboxed child cannot see the host home directory, so the supervisor has to hand it
// an absolute path for each managed tool rather than relying on the child's own PATH.
describe.skipIf(process.platform === "win32")("host tool resolution for sandbox projection", () => {
	it("prefers the managed tools directory over a system installation", async () => {
		const toolsDirectory = await temporaryDirectory();
		const systemDirectory = await temporaryDirectory();
		writeFileSync(join(toolsDirectory, "rg"), "#!/bin/sh\n", { mode: 0o755 });
		writeFileSync(join(systemDirectory, "rg"), "#!/bin/sh\n", { mode: 0o755 });

		expect(resolveHostToolBinary("rg", { toolsDirectory, pathValue: systemDirectory })).toBe(
			join(toolsDirectory, "rg"),
		);
	});

	it("accepts the distribution's alternative name for a system binary", async () => {
		const toolsDirectory = await temporaryDirectory();
		const systemDirectory = await temporaryDirectory();
		writeFileSync(join(systemDirectory, "fdfind"), "#!/bin/sh\n", { mode: 0o755 });

		expect(resolveHostToolBinary("fd", { toolsDirectory, pathValue: systemDirectory })).toBe(
			join(systemDirectory, "fdfind"),
		);
	});

	it("ignores a non-executable file that merely shares the tool's name", async () => {
		const toolsDirectory = await temporaryDirectory();
		const systemDirectory = await temporaryDirectory();
		writeFileSync(join(systemDirectory, "fd"), "not executable", { mode: 0o644 });

		expect(resolveHostToolBinary("fd", { toolsDirectory, pathValue: systemDirectory })).toBeUndefined();
	});

	it("reports nothing to project when the tool is installed nowhere", async () => {
		const toolsDirectory = await temporaryDirectory();
		const systemDirectory = await temporaryDirectory();

		expect(resolveHostToolBinary("rg", { toolsDirectory, pathValue: systemDirectory })).toBeUndefined();
	});
});

// The sandbox projects host tools by bind-mounting over a file in the child's tools
// directory. bwrap creates that mountpoint as an empty file on the host, which outlives
// the namespace — so an unusable 0-byte stub can be sitting there on a later launch.
describe.skipIf(process.platform === "win32")("managed tool lookup ignores unusable files", () => {
	it("does not return a leftover mountpoint stub as if it were the tool", async () => {
		const toolsDirectory = await temporaryDirectory();
		writeFileSync(join(toolsDirectory, "fd"), "", { mode: 0o444 });

		expect(getToolPath("fd", { toolsDirectory })).not.toBe(join(toolsDirectory, "fd"));
	});

	it("still returns a real executable in the managed tools directory", async () => {
		const toolsDirectory = await temporaryDirectory();
		writeFileSync(join(toolsDirectory, "fd"), "#!/bin/sh\n", { mode: 0o755 });

		expect(getToolPath("fd", { toolsDirectory })).toBe(join(toolsDirectory, "fd"));
	});
});
