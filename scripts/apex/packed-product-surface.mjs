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
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";
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

/**
 * `packages/coding-agent` and `packages/agent` are forked, not frozen (ADR 0001) --
 * a link to their upstream `earendil-works/pi-mono` copy points a reader at code
 * that is not what actually shipped, unlike a frozen-package link (`packages/ai`,
 * `tui`, `client`, `protocol`, `server`, `telemetry`), which is correctly the
 * canonical upstream source and must not be flagged. Mechanically precise --
 * zero false-positive risk -- found and fixed across six real doc files in the
 * same audit that established this gate.
 */
const REJECTED_LINK_PATTERNS = [
	{
		pattern: /earendil-works\/pi-mono\/(?:blob|tree)\/main\/packages\/(?:coding-agent|agent)\//,
		reason: "links to upstream Pi source for a forked (not frozen) package instead of Fchery87/apex-code",
	},
];

/**
 * The only real binary this package ships is `apex-code` (see `bin` in
 * package.json) -- a literal bare "pi" spawned, invoked, or set as a container
 * ENTRYPOINT is never correct example code, regardless of surrounding prose.
 * Found and fixed in real Dockerfile/RPC-client examples in the same audit.
 */
const REJECTED_BARE_BINARY_PATTERNS = [
	{ pattern: /ENTRYPOINT\s*\[\s*"pi"\s*\]/, reason: "container ENTRYPOINT names a nonexistent `pi` binary" },
	{ pattern: /spawn\(\s*"pi"\s*,/, reason: "example code spawns a nonexistent `pi` binary" },
	{ pattern: /\[\s*"pi"\s*,\s*"--mode"/, reason: "example code invokes a nonexistent `pi` binary" },
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

const ALL_PATTERNS = [
	...REJECTED_IDENTITY_PATTERNS,
	...REJECTED_LINK_PATTERNS,
	...REJECTED_BARE_BINARY_PATTERNS,
	...REJECTED_SECRET_PATTERNS,
	...REJECTED_ABSOLUTE_PATH_PATTERNS,
];


export const RELEASE_ARTIFACT_MANIFEST_VERSION = 1;
export const REQUIRED_OWNED_PACKAGES = ["apex-code-agent-core", "apex-code"];
export const REQUIRED_STANDALONE_ARTIFACTS = [
	"apex-code-darwin-arm64.tar.gz", "apex-code-darwin-x64.tar.gz",
	"apex-code-linux-arm64.tar.gz", "apex-code-linux-x64.tar.gz",
	"apex-code-windows-arm64.zip", "apex-code-windows-x64.zip",
];

function hashReleaseArtifact(tarballPath) {
	const bytes = readFileSync(tarballPath);
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		sha512: createHash("sha512").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
}

export function createReleaseArtifactRecord({ tarballPath, packed, expectedGitCommit, workflowIdentity }) {
	const absoluteTarballPath = resolve(tarballPath);
	const hashes = hashReleaseArtifact(absoluteTarballPath);
	return {
		packageName: packed.name,
		version: packed.version,
		tarballPath: absoluteTarballPath,
		sha256: hashes.sha256,
		integrity: hashes.integrity,
		expectedGitCommit,
		provenanceSubject: {
			name: `pkg:npm/${packed.name}@${packed.version}`,
			digest: { sha512: hashes.sha512 },
		},
		workflowIdentity,
	};
}

function assertReleaseArtifactRecord(record) {
	if (!record || typeof record !== "object") throw new Error("invalid release artifact record");
	for (const field of ["packageName", "version", "tarballPath", "sha256", "integrity", "expectedGitCommit", "workflowIdentity"]) {
		if (typeof record[field] !== "string" || record[field].length === 0) {
			throw new Error(`invalid release artifact record field: ${field}`);
		}
	}
	if (!isAbsolute(record.tarballPath)) throw new Error("release artifact tarballPath must be absolute");
	if (!/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error("release artifact sha256 must be lowercase hex");
	if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity)) throw new Error("release artifact integrity must be sha512 SRI");
	if (typeof record.provenanceSubject?.name !== "string" || !/^[0-9a-f]{128}$/.test(record.provenanceSubject?.digest?.sha512 ?? "")) {
		throw new Error("release artifact provenance subject is invalid");
	}
}

export function writeReleaseArtifactManifest(path, records, options = {}) {
	for (const record of records) assertReleaseArtifactRecord(record);
	if (records.length !== REQUIRED_OWNED_PACKAGES.length || new Set(records.map((record) => record.packageName)).size !== records.length || !REQUIRED_OWNED_PACKAGES.every((name) => records.some((record) => record.packageName === name))) {
		throw new Error(`release artifact manifest must contain exactly ${REQUIRED_OWNED_PACKAGES.join(" and ")} packages`);
	}
	const identities = new Set(records.map((record) => `${record.expectedGitCommit}\0${record.workflowIdentity}`));
	if (identities.size !== 1) throw new Error("release artifacts must share one commit and workflow identity");
	const [first] = records;
	const standaloneArtifacts = options.standaloneDirectory
		? readdirSync(options.standaloneDirectory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(?:tar\.gz|zip)$/.test(entry.name))
			.map((entry) => {
				const bytes = readFileSync(join(options.standaloneDirectory, entry.name));
				return { filename: entry.name, sha256: createHash("sha256").update(bytes).digest("hex") };
			})
			.sort((left, right) => left.filename.localeCompare(right.filename))
		: [];
	if (options.standaloneDirectory && (standaloneArtifacts.length !== REQUIRED_STANDALONE_ARTIFACTS.length || standaloneArtifacts.some((entry, index) => entry.filename !== REQUIRED_STANDALONE_ARTIFACTS.slice().sort()[index]))) {
		throw new Error("release artifact manifest must contain exactly the six required standalone archives");
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({
		schemaVersion: RELEASE_ARTIFACT_MANIFEST_VERSION,
		releaseIdentity: { expectedGitCommit: first.expectedGitCommit, workflowIdentity: first.workflowIdentity },
		artifacts: records,
		standaloneArtifacts,
	}, null, "\t")}\n`);
}

/**
 * RI-B5. The single decision for whether a *publishable* release record may be
 * written. The manifest used to be written before the smoke install ran, so a
 * failed smoke still left a digest-valid record that publish-release-artifact.mjs
 * would consume -- the record then asserted an ADR 0018 claim ("these tarballs
 * passed smoke") that nothing had established. A manifest request without
 * `--smoke` is rejected outright rather than silently producing an unproven
 * record.
 */
export function releaseManifestGate({ manifestOut, smokeRequested, smokeOk, identityFailed }) {
	if (!manifestOut) return { write: false };
	if (!smokeRequested) {
		return { write: false, error: "--manifest-out requires --smoke: a publishable release record must not exist without a passing functional smoke" };
	}
	if (identityFailed) return { write: false, error: "packed-artifact identity check failed; no publishable release record written" };
	if (!smokeOk) return { write: false, error: "functional smoke failed; no publishable release record written" };
	return { write: true };
}

export function readReleaseArtifactDocument(path) {
	const document = JSON.parse(readFileSync(path, "utf8"));
	if (document.schemaVersion !== RELEASE_ARTIFACT_MANIFEST_VERSION || !Array.isArray(document.artifacts) || !Array.isArray(document.standaloneArtifacts)) {
		throw new Error(`unsupported release artifact manifest: ${path}`);
	}
	if (document.artifacts.length !== REQUIRED_OWNED_PACKAGES.length || new Set(document.artifacts.map((record) => record.packageName)).size !== document.artifacts.length || !REQUIRED_OWNED_PACKAGES.every((name) => document.artifacts.some((record) => record.packageName === name))) throw new Error("release artifact manifest must contain exactly the two Apex-owned packages");
	if (!document.releaseIdentity || typeof document.releaseIdentity.expectedGitCommit !== "string" || typeof document.releaseIdentity.workflowIdentity !== "string") throw new Error("release artifact manifest has invalid releaseIdentity");
	for (const record of document.artifacts) assertReleaseArtifactRecord(record);
	if (document.artifacts.some((record) => record.expectedGitCommit !== document.releaseIdentity.expectedGitCommit || record.workflowIdentity !== document.releaseIdentity.workflowIdentity)) throw new Error("release artifact identity does not match package records");
	const names = document.standaloneArtifacts.map((entry) => entry?.filename);
	if (names.length !== REQUIRED_STANDALONE_ARTIFACTS.length || new Set(names).size !== names.length || REQUIRED_STANDALONE_ARTIFACTS.some((name) => !names.includes(name))) throw new Error("release artifact manifest must contain exactly the six required standalone archives");
	for (const entry of document.standaloneArtifacts) if (!/^sha256-[a-f0-9]{64}$/.test(`sha256-${entry?.sha256 ?? ""}`) || typeof entry.filename !== "string") throw new Error("invalid standalone artifact record");
	return document;
}

export function readReleaseArtifactManifest(path) {
	return readReleaseArtifactDocument(path).artifacts;
}

export function verifyStandaloneArtifacts(document, directory) {
	const problems = [];
	for (const record of document.standaloneArtifacts) {
		const path = join(directory, record.filename);
		try {
			const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
			if (actual !== record.sha256) problems.push(`${record.filename}: sha256 ${actual} does not match release artifact record ${record.sha256}`);
		} catch (error) {
			problems.push(`${record.filename}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return problems;
}

/** Pack a package directory for real and extract the tarball. Never `--dry-run`:
 * a dry run proves the tarball builds, not that its contents are reviewed. */
export function packToDirectory(packageDirectory, destinationDirectory) {
	mkdirSync(destinationDirectory, { recursive: true });
	const output = execFileSync(
		"npm",
		npmSpawnArgs(["pack", "--json", "--ignore-scripts", "--pack-destination", destinationDirectory]),
		npmSpawnOptions({ cwd: packageDirectory, encoding: "utf8" }),
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
 * debug-symbol policy is a separate, not-yet-made decision) plus every packed
 * `.md` file -- not just the top-level README. `packages/coding-agent`'s
 * `files` field ships `docs/` and `CHANGELOG.md` too, and a real audit found
 * stale, occasionally broken (nonexistent `pi` command, wrong upstream links)
 * "Pi"-branded content across most of `docs/` that a README-only scan never
 * observed, exactly the kind of gap this gate exists to close.
 */
export function checkPackedProductSurface(extractedDirectory, options = {}) {
	const violations = [];
	// CHANGELOG.md is a past-tense historical record (mirrors the source-level
	// scans in scripts/product-surface.test.mjs, which never read it either):
	// entries like "Removed implicit pi.dev model-catalog..." or "restarting
	// with `pi -ne`" describe what Pi/Apex Code *used to* do, not a live
	// violation, and must not be flagged.
	const scanned = listFiles(
		extractedDirectory,
		(path) => (path.endsWith(".js") || path.endsWith(".md")) && basename(path) !== "CHANGELOG.md",
	);

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
export function checkAllOwnedPackages(destinationDirectory, identity = {}) {
	const report = [];
	for (const pkg of getPublicWorkspacePackages()) {
		const { extractedDirectory, packed } = packToDirectory(pkg.directory, destinationDirectory);
		const violations = checkPackedProductSurface(extractedDirectory, { requireApexReadme: pkg.name === "apex-code" });
		const artifact = identity.expectedGitCommit && identity.workflowIdentity
			? createReleaseArtifactRecord({
				tarballPath: join(destinationDirectory, packed.filename),
				packed,
				expectedGitCommit: identity.expectedGitCommit,
				workflowIdentity: identity.workflowIdentity,
			})
			: undefined;
		report.push({ name: pkg.name, version: pkg.version, filename: packed.filename, violations, artifact });
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
		`${JSON.stringify({ name: "apex-packed-smoke-install", version: "0.0.0", private: true, dependencies }, null, "\t")}\n`,
	);
	execFileSync(
		"npm",
		npmSpawnArgs(["install", "--omit=dev", "--ignore-scripts", "--package-lock=false", "--install-strategy=nested"]),
		npmSpawnOptions({ cwd: installDirectory, stdio: "inherit" }),
	);
	execFileSync(
		"npm",
		npmSpawnArgs(["install", "--package-lock-only", "--ignore-scripts"]),
		npmSpawnOptions({ cwd: installDirectory, stdio: "inherit" }),
	);
	const cliPath = join(installDirectory, "node_modules", "apex-code");
	const corePath = join(installDirectory, "node_modules", "apex-code-agent-core");
	if (existsSync(cliPath) && existsSync(corePath)) {
		const cliNodeModules = join(cliPath, "node_modules");
		mkdirSync(cliNodeModules, { recursive: true });
		cpSync(corePath, join(cliNodeModules, "apex-code-agent-core"), { recursive: true });
	}
}

/**
 * Run a provider-independent functional smoke test against an installed CLI:
 * a real session, a scripted fake-provider turn, no network call to
 * any real model provider. Proves the packed-and-installed artifact actually
 * runs, not just that its static content passes the identity check above.
 */
export function runPackedFunctionalSmoke(installDirectory, options = {}) {
	const binaryName = process.platform === "win32" ? "apex-code.cmd" : "apex-code";
	const cliPath = join(installDirectory, "node_modules", ".bin", binaryName);
	const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "apex-packed-smoke-workspace-"));
	const agentDirectory = options.agentDirectory ?? mkdtempSync(join(tmpdir(), "apex-packed-smoke-agent-"));

	// The child runs with the workspace as its working directory, so the
	// extension fixture is copied into the workspace rather than referenced
	// from the source checkout.
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
	const valueFor = (flag) => {
		const index = process.argv.indexOf(flag);
		return index !== -1 ? process.argv[index + 1] : undefined;
	};
	const expectedGitCommit = valueFor("--git-head");
	const workflowIdentity = valueFor("--workflow-identity");
	const manifestOut = valueFor("--manifest-out");
	const standaloneDirectory = valueFor("--standalone-directory");
	if ([expectedGitCommit, workflowIdentity, manifestOut].some(Boolean) && ![expectedGitCommit, workflowIdentity, manifestOut].every(Boolean)) {
		throw new Error("--git-head, --workflow-identity, and --manifest-out must be supplied together");
	}
	// Checked before anything is packed: refusing late would still have spent a
	// full pack/install cycle producing a record it must then throw away.
	const earlyGate = releaseManifestGate({ manifestOut, smokeRequested: runSmoke, smokeOk: false, identityFailed: false });
	if (manifestOut && !runSmoke) {
		console.error(earlyGate.error);
		process.exit(1);
	}

	const report = checkAllOwnedPackages(destinationDirectory, { expectedGitCommit, workflowIdentity });
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


	const identityFailed = failed;
	let smokeOk = false;
	if (!failed && runSmoke) {
		console.log("\nRunning provider-independent functional smoke test against a clean install...");
		const installDirectory = join(destinationDirectory, "smoke-install");
		installPackedTarballs(tarballsByName, installDirectory);
		const smoke = runPackedFunctionalSmoke(installDirectory);
		smokeOk = smoke.ok;
		if (smoke.ok) {
			console.log("✓ functional smoke test completed a real turn through the packed, installed CLI");
		} else {
			failed = true;
			console.error(`✗ functional smoke test failed (status ${smoke.status})`);
			console.error(smoke.stdout);
			console.error(smoke.stderr);
		}
	}

	const gate = releaseManifestGate({ manifestOut, smokeRequested: runSmoke, smokeOk, identityFailed });
	if (gate.write) {
		writeReleaseArtifactManifest(resolve(manifestOut), report.map((entry) => entry.artifact), { standaloneDirectory });
		console.log(`Wrote immutable release artifact manifest to ${resolve(manifestOut)}`);
	} else if (gate.error) {
		failed = true;
		console.error(gate.error);
	}

	process.exit(failed ? 1 : 0);
}
