#!/usr/bin/env node
/**
 * Generate a CycloneDX SBOM for each Apex-owned package's production
 * dependency graph (ADR 0018, task 12.11).
 *
 * Wraps `npm sbom` (built into npm 9+) rather than adding a new dependency for
 * this. Validates the output actually parses and lists at least one component
 * before writing it -- `npm sbom` exits 0 even when it silently produces an
 * empty or malformed document for a misconfigured workspace, so writing the
 * output unchecked would let a broken SBOM pass as generated evidence.
 *
 * Usage:
 *   node scripts/apex/generate-sbom.mjs [--out-dir <dir>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";
import { getPublicWorkspacePackages } from "../release-packages.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".artifacts");

/** Generate one package's SBOM. Throws if npm sbom fails or the output is empty/malformed. */
export function generateSbomFor(pkg, cwd = REPO_ROOT) {
	// npm resolves --workspace against its own internally realpath'd workspace
	// list; on macOS /tmp is itself a symlink (-> /private/tmp), so an
	// unresolved path can fail to match with "No workspaces found" even though
	// it is the correct directory. Resolve both sides the same way.
	const output = execFileSync(
		"npm",
		npmSpawnArgs(["sbom", "--workspace", realpathSync(pkg.directory), "--omit", "dev", "--sbom-format", "cyclonedx"]),
		npmSpawnOptions({ cwd: realpathSync(cwd), encoding: "utf8" }),
	);
	let document;
	try {
		document = JSON.parse(output);
	} catch (error) {
		throw new Error(`npm sbom for ${pkg.name} did not produce valid JSON: ${error instanceof Error ? error.message : error}`);
	}
	// npm sbom always includes the scanned workspace package itself as one
	// component even with zero real dependencies, so "empty" is <= 1, not 0.
	if (!Array.isArray(document.components) || document.components.length <= 1) {
		throw new Error(
			`npm sbom for ${pkg.name} produced no real dependency components -- refusing to write a near-empty SBOM as evidence`,
		);
	}
	return document;
}

export function generateAllSboms(outDir = DEFAULT_OUT_DIR) {
	mkdirSync(outDir, { recursive: true });
	const written = [];
	for (const pkg of getPublicWorkspacePackages()) {
		const document = generateSbomFor(pkg);
		const outPath = join(outDir, `sbom-${pkg.name.replace(/[@/]/g, "_")}.cyclonedx.json`);
		writeFileSync(outPath, `${JSON.stringify(document, null, "\t")}\n`);
		written.push({ name: pkg.name, path: outPath, componentCount: document.components.length });
	}
	return written;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const outFlagIndex = process.argv.indexOf("--out-dir");
	const outDir = outFlagIndex !== -1 && process.argv[outFlagIndex + 1] ? resolve(process.argv[outFlagIndex + 1]) : DEFAULT_OUT_DIR;
	try {
		const written = generateAllSboms(outDir);
		for (const entry of written) {
			console.log(`Wrote ${entry.componentCount}-component SBOM for ${entry.name} to ${entry.path}`);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
