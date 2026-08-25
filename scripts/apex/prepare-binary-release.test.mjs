import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const producerUrl = new URL("./prepare-binary-release.mjs", import.meta.url);
const posixInstallerUrl = new URL("../../install.sh", import.meta.url);
const powershellInstallerUrl = new URL("../../install.ps1", import.meta.url);
const execFileAsync = promisify(execFile);

const expectedAssets = [
	"apex-code-darwin-arm64.tar.gz",
	"apex-code-darwin-x64.tar.gz",
	"apex-code-linux-arm64.tar.gz",
	"apex-code-linux-x64.tar.gz",
	"apex-code-windows-arm64.zip",
	"apex-code-windows-x64.zip",
];

async function writeFixtureAssets(directory) {
	for (const [index, asset] of expectedAssets.entries()) {
		await writeFile(join(directory, asset), `fixture-${index}`);
	}
}

test("binary release preparation accepts exactly the supported archives and writes a deterministic manifest", async () => {
	const { BINARY_RELEASE_ASSETS, prepareBinaryRelease } = await import(producerUrl);
	assert.deepEqual(BINARY_RELEASE_ASSETS, expectedAssets);

	const directory = await mkdtemp(join(tmpdir(), "apex-code-binary-release-"));
	await writeFixtureAssets(directory);

	const manifestPath = await prepareBinaryRelease(directory);
	assert.equal(manifestPath, join(directory, "SHA256SUMS"));

	const expectedManifest = expectedAssets
		.map((asset, index) => `${createHash("sha256").update(`fixture-${index}`).digest("hex")}  ${asset}`)
		.join("\n");
	assert.equal(await readFile(manifestPath, "utf8"), `${expectedManifest}\n`);
});

test("binary release preparation rejects an incomplete or unexpected archive set", async () => {
	const { prepareBinaryRelease } = await import(producerUrl);
	const directory = await mkdtemp(join(tmpdir(), "apex-code-binary-release-"));
	await writeFixtureAssets(directory);
	await writeFile(join(directory, "unexpected.zip"), "unexpected");

	await assert.rejects(prepareBinaryRelease(directory), /unexpected\.zip/);
});

test("the POSIX installer supports Unix and Git Bash while verifying before extraction", async () => {
	const installer = await readFile(posixInstallerUrl, "utf8");

	assert.match(installer, /^#!\/usr\/bin\/env bash/m);
	assert.match(installer, /set -Eeuo pipefail/);
	assert.match(installer, /APEX_CODE_INSTALL_VERSION/);
	assert.match(installer, /MINGW|MSYS|CYGWIN/);
	assert.match(installer, /SHA256SUMS/);
	assert.match(installer, /sha256sum|shasum/);
	assert.match(installer, /tar -xzf|unzip/);
	assert.match(installer, /powershell\.exe/);
	assert.match(installer, /Expand-Archive/);
	assert.match(installer, /\.local\/bin/);
	assert.match(installer, /LOCALAPPDATA/);
	assert.match(installer, /PATH/);

	const verifyIndex = installer.search(/sha256sum|shasum/);
	const extractIndex = installer.search(/tar -xzf|unzip/);
	assert.ok(verifyIndex >= 0 && verifyIndex < extractIndex, "the archive must be verified before extraction");
});

test("the POSIX installer performs a checksum-verified Linux install without touching the existing PATH", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-code-posix-installer-"));
	const fixtureDirectory = join(root, "fixtures");
	const sourceDirectory = join(root, "source", "apex-code");
	const fakeBinDirectory = join(root, "fake-bin");
	const homeDirectory = join(root, "home");
	const asset = "apex-code-linux-x64.tar.gz";
	await mkdir(sourceDirectory, { recursive: true });
	await mkdir(fixtureDirectory, { recursive: true });
	await mkdir(fakeBinDirectory, { recursive: true });
	await mkdir(homeDirectory, { recursive: true });
	await writeFile(join(sourceDirectory, "apex-code"), "#!/usr/bin/env sh\nprintf '%s\\n' 1.2.3\n");
	await chmod(join(sourceDirectory, "apex-code"), 0o755);
	await execFileAsync("tar", ["-czf", join(fixtureDirectory, asset), "-C", join(root, "source"), "apex-code"]);
	const hash = createHash("sha256").update(await readFile(join(fixtureDirectory, asset))).digest("hex");
	await writeFile(join(fixtureDirectory, "SHA256SUMS"), `${hash}  ${asset}\n`);
	await writeFile(
		join(fakeBinDirectory, "curl"),
		"#!/usr/bin/env bash\nset -Eeuo pipefail\nout=''\nwhile [[ $# -gt 0 ]]; do\n  case \"$1\" in\n    --output) out=\"$2\"; shift 2 ;;\n    *) url=\"$1\"; shift ;;\n  esac\ndone\ncp \"$APEX_INSTALL_FIXTURE/${url##*/}\" \"$out\"\n",
	);
	await chmod(join(fakeBinDirectory, "curl"), 0o755);

	await execFileAsync("bash", [fileURLToPath(posixInstallerUrl)], {
		env: {
			...process.env,
			APEX_CODE_INSTALL_VERSION: "1.2.3",
			APEX_INSTALL_FIXTURE: fixtureDirectory,
			HOME: homeDirectory,
			PATH: `${fakeBinDirectory}:${process.env.PATH}`,
		},
	});

	const executable = join(homeDirectory, ".local", "share", "apex-code", "1.2.3", "apex-code");
	const command = join(homeDirectory, ".local", "bin", "apex-code");
	assert.equal((await execFileAsync(executable, [])).stdout.trim(), "1.2.3");
	assert.ok((await lstat(command)).isSymbolicLink());
	assert.equal(await readlink(command), executable);
	assert.match(await readFile(join(homeDirectory, ".profile"), "utf8"), /apex-code installer path/);
});

test("the PowerShell installer verifies a Windows archive and updates only the user PATH", async () => {
	const installer = await readFile(powershellInstallerUrl, "utf8");

	assert.match(installer, /Set-StrictMode -Version Latest/);
	assert.match(installer, /\$ErrorActionPreference = "Stop"/);
	assert.match(installer, /APEX_CODE_INSTALL_VERSION/);
	assert.match(installer, /LocalApplicationData/);
	assert.match(installer, /SHA256SUMS/);
	assert.match(installer, /Get-FileHash/);
	assert.match(installer, /Expand-Archive/);
	assert.match(installer, /\[EnvironmentVariableTarget\]::User/);

	const verifyIndex = installer.indexOf("Get-FileHash");
	const extractIndex = installer.indexOf("Expand-Archive");
	assert.ok(verifyIndex >= 0 && verifyIndex < extractIndex, "the archive must be verified before extraction");
});
