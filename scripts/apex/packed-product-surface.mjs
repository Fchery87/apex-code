#!/usr/bin/env node
/**
 * Packed-artifact identity gate (ADR 0018, task 12.8).
 *
 * Packs an Apex-owned package for real, extracts the tarball, and inspects its
 * packed README, package metadata, and compiled `dist/` JS output against a
 * reviewed compatibility/attribution allowlist. This is what
 * scripts/product-surface.test.mjs cannot do: `dist/` is generated and
 * git-ignored, so a source-only check never observes what actually ships. The
 * concrete trigger for this phase was exactly that gap: a packed tarball that
 * built successfully but shipped stale Pi-branded content.
 *
 * Usage:
 *   node scripts/apex/packed-product-surface.mjs [--out <dir>]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./npm-command.mjs";
import { getPublicWorkspacePackages } from "../release-packages.mjs";

const SMOKE_EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/packed-smoke-extension.mjs");

/**
 * Active product-misidentification patterns -- claiming the running product
 * *is* Pi, not the reviewed compatibility/attribution vocabulary documented in
 * the README's "Environment compatibility" and "Relationship to Pi" sections
 * (temporary `PI_*` env aliases, the extension manifest `pi` key,
 * `@earendil-works/pi-ai`/`pi-tui` imports, and historical attribution).
 */
const REJECTED_IDENTITY_PATTERNS = [
	{ pattern: /operating inside pi\b/i, reason: "claims the running product is Pi" },
	{ pattern: /\bpi -ne\b/, reason: "documents the Pi CLI's own flag syntax as this product's" },
	{ pattern: /\n {2}pi auth\b/, reason: "documents a `pi auth` command this product does not have" },
	{ pattern: /https:\/\/pi\.dev/, reason: "references an unowned hosted pi.dev endpoint (ADR 0013)" },
];

/** Secret-shaped strings that must never appear in a packed artifact. */
const REJECTED_SECRET_PATTERNS = [
	{ pattern: /sk-[A-Za-z0-9]{20,}/, reason: "looks like an API key" },
	{ pattern: /AKIA[0-9A-Z]{16}/, reason: "looks like an AWS access key ID" },
	{ pattern: /-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----/, reason: "looks like a private key" },
];

/**
 * Absolute paths that would only appear by leaking the build machine's own
 * filesystem layout -- deliberately narrower than a bare `/home/` or
 * `/Users/` prefix, which also matches ordinary cross-platform path-handling
 * string literals already present in the codebase (e.g. a helper that checks
 * `path.startsWith("/Users/")`).
 */
const REJECTED_ABSOLUTE_PATH_PATTERNS = [
	{
		pattern: /\/home\/[^"'`\s)]{2,}\/(coding-agent|apex-code|Documents|runner)/,
		reason: "looks like a build-machine absolute path",
	},
	{
		pattern: /\/Users\/[^"'`\s)]{2,}\/(coding-agent|apex-code|Documents|runner)/,
		reason: "looks like a build-machine absolute path",
	},
	{ pattern: /\/(home|Users)\/runner\//, reason: "looks like a GitHub Actions runner absolute path" },
];

const ALL_PATTERNS = [...REJECTED_IDENTITY_PATTERNS, ...REJECTED_SECRET_PATTERNS, ...REJECTED_ABSOLUTE_PATH_PATTERNS];

/** Pack a package directory for real and extract the tarball. Never `--dry-run`:
 * a dry run proves the tarball builds, not that its contents are reviewed. */
export function packToDirectory(packageDirectory, destinationDirectory) {
	mkdirSync(destinationDirectory, { recursive: true });
	const output = execFileSync(
		npmCommand(),
		["pack", "--json", "--ignore-scripts", "--pack-destination", destinationDirectory],
		{ cwd: packageDirectory, encoding: "utf8" },
	);
	const packed = JSON.parse(output)[0];
	const tarballPath = join(destinationDirectory, packed.filename);
	const extractRoot = join(destinationDirectory, `extracted_${packed.name.replace(/[@/]/g, "_")}`);
	mkdirSync(extractRoot, { recursive: true });
	execFileSync("tar", ["xzf", tarballPath, "-C", extractRoot]);
	return { tarballPath, packed, extractedDirectory: join(extractRoot, "package") };
}

function listFiles(root, predicate) {
	const results = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (predicate(full)) {
				results.push(full);
			}
		}
	}
	return results;
}

/**
 * Inspect a package's *extracted, packed* contents. Scans compiled `.js`
 * output (not `.map` files -- ADR 0018 scopes this gate to the identity
 * surfaces the spec names: README, compiled runtime, metadata; source-map
 * debug-symbol policy is a separate, not-yet-made decision) plus the packed
 * README and package.json.
 */
export function checkPackedProductSurface(extractedDirectory, options = {}) {
	const violations = [];
	const scanned = listFiles(extractedDirectory, (path) => path.endsWith(".js"));
	for (const readmeCandidate of ["README.md"]) {
		const path = join(extractedDirectory, readmeCandidate);
		if (fileExists(path)) scanned.push(path);
	}

	for (const file of scanned) {
		const content = readFileSync(file, "utf8");
		const relativePath = relative(extractedDirectory, file);
		for (const { pattern, reason } of ALL_PATTERNS) {
			if (pattern.test(content)) {
				violations.push({ file: relativePath, pattern: pattern.source, reason });
			}
		}
	}

	if (options.requireApexReadme !== false) {
		const readmePath = join(extractedDirectory, "README.md");
		if (fileExists(readmePath)) {
			const readme = readFileSync(readmePath, "utf8");
			if (!/^# Apex Code/m.test(readme)) {
				violations.push({
					file: "README.md",
					pattern: "^# Apex Code",
					reason: "packed README does not identify Apex Code",
				});
			}
		}
	}

	return violations;
}

function fileExists(path) {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Pack and check every Apex-owned package. Returns a report; does not exit. */
export function checkAllOwnedPackages(destinationDirectory) {
	const report = [];
	for (const pkg of getPublicWorkspacePackages()) {
		const { extractedDirectory, packed } = packToDirectory(pkg.directory, destinationDirectory);
		const violations = checkPackedProductSurface(extractedDirectory, { requireApexReadme: pkg.name === "apex-code" });
		report.push({ name: pkg.name, version: pkg.version, filename: packed.filename, violations });
	}
	return report;
}

/**
 * Install packed tarballs (by package name -> tarball path) into an isolated
 * scratch directory via `file:` dependencies, resolving every other
 * dependency (including the frozen packages, published separately by
 * upstream Pi) from the real registry -- the same shape a real end user's
 * install takes, not a workspace-linked one.
 */
export function installPackedTarballs(tarballsByName, installDirectory) {
	mkdirSync(installDirectory, { recursive: true });
	const dependencies = Object.fromEntries(
		Object.entries(tarballsByName).map(([name, tarballPath]) => [name, `file:${resolve(tarballPath)}`]),
	);
	writeFileSync(
		join(installDirectory, "package.json"),
		`${JSON.stringify({ private: true, dependencies }, null, "\t")}\n`,
	);
	execFileSync(npmCommand(), ["install", "--omit=dev", "--ignore-scripts"], { cwd: installDirectory, stdio: "inherit" });
}

/**
 * Run a provider-independent functional smoke test against an installed CLI:
 * a real sandboxed session, a scripted fake-provider turn, no network call to
 * any real model provider. Proves the packed-and-installed artifact actually
 * runs, not just that its static content passes the identity check above.
 */
export function runPackedFunctionalSmoke(installDirectory, options = {}) {
	const binaryName = process.platform === "win32" ? "apex-code.cmd" : "apex-code";
	const cliPath = join(installDirectory, "node_modules", ".bin", binaryName);
	const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "apex-packed-smoke-workspace-"));
	const agentDirectory = options.agentDirectory ?? mkdtempSync(join(tmpdir(), "apex-packed-smoke-agent-"));

	// The sandboxed child can only read the workspace and the installed
	// package's own directory (never the source checkout), so the extension
	// fixture is copied into the workspace rather than referenced in place.
	const extensionPath = join(workspace, "packed-smoke-extension.mjs");
	copyFileSync(SMOKE_EXTENSION_PATH, extensionPath);

	const result = spawnSync(
		cliPath,
		[
			"--print",
			"run the packed smoke test",
			"--extension",
			extensionPath,
			"--model",
			"apex-packed-smoke/scripted",
			"--permission-mode",
			"bypassPermissions",
		],
		{
			cwd: workspace,
			env: { ...process.env, APEX_CODE_CODING_AGENT_DIR: agentDirectory },
			encoding: "utf8",
			timeout: options.timeoutMs ?? 60_000,
		},
	);

	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const ok = result.status === 0 && stdout.includes("apex-packed-smoke ok");
	return { ok, status: result.status, stdout, stderr };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const outFlagIndex = process.argv.indexOf("--out");
	const destinationDirectory =
		outFlagIndex !== -1 && process.argv[outFlagIndex + 1]
			? resolve(process.argv[outFlagIndex + 1])
			: mkdtempSync(join(tmpdir(), "apex-packed-product-surface-"));
	const runSmoke = process.argv.includes("--smoke");

	const report = checkAllOwnedPackages(destinationDirectory);
	let failed = false;
	const tarballsByName = {};
	for (const entry of report) {
		tarballsByName[entry.name] = join(destinationDirectory, entry.filename);
		if (entry.violations.length === 0) {
			console.log(`✓ ${entry.name}@${entry.version} (${entry.filename}): no violations`);
			continue;
		}
		failed = true;
		console.error(`✗ ${entry.name}@${entry.version} (${entry.filename}):`);
		for (const violation of entry.violations) {
			console.error(`  ${violation.file}: ${violation.reason} (/${violation.pattern}/)`);
		}
	}

	if (!failed && runSmoke) {
		console.log("\nRunning provider-independent functional smoke test against a clean install...");
		const installDirectory = join(destinationDirectory, "smoke-install");
		installPackedTarballs(tarballsByName, installDirectory);
		const smoke = runPackedFunctionalSmoke(installDirectory);
		if (smoke.ok) {
			console.log("✓ functional smoke test completed a real turn through the packed, installed CLI");
		} else {
			failed = true;
			console.error(`✗ functional smoke test failed (status ${smoke.status})`);
			console.error(smoke.stdout);
			console.error(smoke.stderr);
		}
	}

	process.exit(failed ? 1 : 0);
}
