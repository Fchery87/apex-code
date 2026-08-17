import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

async function writeOwnedPackages(root, version) {
	await writeManifest(root, "packages/agent", {
		name: "apex-code-agent-core",
		version,
	});
	await writeManifest(root, "packages/coding-agent", {
		name: "apex-code",
		version,
		dependencies: {
			"apex-code-agent-core": version,
		},
	});
}

test("synchronizes private dependencies without touching registry aliases, generated manifests, or frozen packages", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeOwnedPackages(root, "2.0.0");
		// Stand-in for a frozen package (ADR 0001): a real one, at a version that
		// intentionally does not match the owned lockstep version.
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "0.84.1",
		});
		await writeManifest(root, "packages/evals", {
			name: "@earendil-works/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"apex-code": "^1.0.0",
				"apex-code-agent-core": "1.0.0",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"apex-code": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		// Dependents of an Apex-owned package are pinned exactly (ADR 0018),
		// matching what scripts/apex/validate-release-tag.mjs enforces at the
		// release gate for apex-code's own dependency on apex-code-agent-core.
		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["apex-code"], "2.0.0");
		assert.equal(evalsManifest.dependencies["apex-code-agent-core"], "2.0.0");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");

		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["apex-code"], "^1.0.0");

		// The frozen stand-in's own package.json is never written, even though its
		// version does not match the owned lockstep version.
		const frozenManifest = await readManifest(root, "packages/ai");
		assert.equal(frozenManifest.version, "0.84.1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("lockstep validation checks only the two Apex-owned packages, not frozen ones", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeOwnedPackages(root, "2.0.0");
		// A frozen-package stand-in at a different version must never fail lockstep
		// validation -- that was the real, previously-latent defect this fixes.
		await writeManifest(root, "packages/ai", {
			name: "@earendil-works/pi-ai",
			version: "0.84.1",
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		await writeManifest(root, "packages/coding-agent", {
			name: "apex-code",
			version: "3.0.0",
			dependencies: { "apex-code-agent-core": "2.0.0" },
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
		assert.match(lockstepFailure.stderr, /apex-code-agent-core and apex-code are not lockstep versioned/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
