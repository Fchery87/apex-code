#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const BINARY_RELEASE_ASSETS = Object.freeze([
	"apex-code-darwin-arm64.tar.gz",
	"apex-code-darwin-x64.tar.gz",
	"apex-code-linux-arm64.tar.gz",
	"apex-code-linux-x64.tar.gz",
	"apex-code-windows-arm64.zip",
	"apex-code-windows-x64.zip",
]);

function usage() {
	return "Usage: node scripts/apex/prepare-binary-release.mjs <archive-directory>";
}

export async function prepareBinaryRelease(directory) {
	const archiveDirectory = resolve(directory);
	const entries = await readdir(archiveDirectory, { withFileTypes: true });
	const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
	files.delete("SHA256SUMS");

	const unexpected = [...files].filter((file) => !BINARY_RELEASE_ASSETS.includes(file)).sort();
	const missing = BINARY_RELEASE_ASSETS.filter((asset) => !files.has(asset));
	if (unexpected.length > 0 || missing.length > 0) {
		const problems = [
			unexpected.length > 0 && `unexpected files: ${unexpected.join(", ")}`,
			missing.length > 0 && `missing files: ${missing.join(", ")}`,
		].filter(Boolean);
		throw new Error(`Invalid standalone release archive set in ${archiveDirectory}: ${problems.join("; ")}`);
	}

	const lines = [];
	for (const asset of BINARY_RELEASE_ASSETS) {
		const data = await readFile(resolve(archiveDirectory, asset));
		lines.push(`${createHash("sha256").update(data).digest("hex")}  ${asset}`);
	}

	const manifestPath = resolve(archiveDirectory, "SHA256SUMS");
	await writeFile(manifestPath, `${lines.join("\n")}\n`);
	return manifestPath;
}

if (import.meta.main) {
	const [directory, ...extra] = process.argv.slice(2);
	if (!directory || extra.length > 0 || basename(directory) === "") {
		console.error(usage());
		process.exitCode = 1;
	} else {
		prepareBinaryRelease(directory)
			.then((manifestPath) => console.log(`Wrote ${manifestPath}`))
			.catch((error) => {
				console.error(error.message);
				process.exitCode = 1;
			});
	}
}
