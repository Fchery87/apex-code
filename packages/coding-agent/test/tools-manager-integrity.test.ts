import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installManagedToolArchive, resolveManagedToolArtifact } from "../src/utils/tools-manager.ts";

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
