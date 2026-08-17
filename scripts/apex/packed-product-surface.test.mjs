import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPublicWorkspacePackages } from "../release-packages.mjs";
import {
	checkAllOwnedPackages,
	checkPackedProductSurface,
	installPackedTarballs,
	packToDirectory,
	runPackedFunctionalSmoke,
} from "./packed-product-surface.mjs";

async function withTempDir(run) {
	const directory = await mkdtemp(join(tmpdir(), "apex-packed-surface-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("passes a clean packed directory with no violations", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n\nSome docs.\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "cli.js"), "console.log('operating inside Apex Code');\n");

		assert.deepEqual(checkPackedProductSurface(root), []);
	});
});

test("catches active Pi product misidentification in compiled dist output", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "main.js"), "const message = 'operating inside pi';\n");

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].file, join("dist", "main.js"));
		assert.match(violations[0].reason, /claims the running product is Pi/);
	});
});

test("catches a secret-shaped string in compiled dist output", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "config.js"), `const fallback = "sk-${"a".repeat(32)}";\n`);

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.match(violations[0].reason, /API key/);
	});
});

test("catches a build-machine absolute path without flagging ordinary cross-platform path logic", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "dist"), { recursive: true });
		// Real shape found in this codebase's own export-html template: ordinary
		// generic path-prefix logic, never a leaked absolute path.
		await writeFile(
			join(root, "dist", "safe.js"),
			"function shortenPath(p) { if (p.startsWith('/Users/')) return '~'; if (p.startsWith('/home/')) return '~'; }\n",
		);
		await writeFile(
			join(root, "dist", "leaked.js"),
			"// built at /home/ci-builder/Documents/coding-agent/src/cli.ts\nexport const x = 1;\n",
		);

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].file, join("dist", "leaked.js"));
		assert.match(violations[0].reason, /build-machine absolute path/);
	});
});

test("catches a packed README that does not identify Apex Code", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Pi\n\nOld branding.\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "cli.js"), "console.log('hi');\n");

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.match(violations[0].reason, /does not identify Apex Code/);
	});
});

// This test packs, installs from the real npm registry, and runs a real
// sandboxed turn -- real network access and ~20s, unlike every other test in
// this file. .github/workflows/release.yml already runs the equivalent check
// as its own required pre-publish step (node scripts/apex/packed-product-surface.mjs
// --smoke; see release-workflow.test.mjs's "gate runs before either publish
// step" test for that wiring), so this stays opt-in rather than adding real
// network dependency to every ordinary `npm test` run.
const bothOwnedPackagesAreBuilt = getPublicWorkspacePackages().every((pkg) => existsSync(join(pkg.directory, "dist")));
const smokeTestOptedIn = process.env.APEX_PACKED_SMOKE_TEST === "1";

test(
	"a clean scratch install of both real packed Apex tarballs completes a real turn (opt-in: APEX_PACKED_SMOKE_TEST=1, requires npm run build first)",
	{ skip: !smokeTestOptedIn || !bothOwnedPackagesAreBuilt, timeout: 120_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "apex-packed-smoke-"));
		try {
			const report = checkAllOwnedPackages(root);
			for (const entry of report) {
				assert.deepEqual(entry.violations, [], `${entry.name}: ${JSON.stringify(entry.violations)}`);
			}

			const tarballsByName = Object.fromEntries(report.map((entry) => [entry.name, join(root, entry.filename)]));
			const installDirectory = join(root, "install");
			installPackedTarballs(tarballsByName, installDirectory);

			const smoke = runPackedFunctionalSmoke(installDirectory);
			assert.ok(smoke.ok, `smoke test failed (status ${smoke.status}):\n${smoke.stdout}\n${smoke.stderr}`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("packToDirectory packs and extracts a real tarball for a synthetic package", async () => {
	await withTempDir(async (root) => {
		const packageDirectory = join(root, "pkg");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "apex-packed-surface-fixture", version: "1.0.0", files: ["index.js"] }, null, "\t"),
		);
		await writeFile(join(packageDirectory, "index.js"), "console.log('operating inside Apex Code');\n");
		const destination = join(root, "out");

		const { extractedDirectory, packed } = packToDirectory(packageDirectory, destination);

		assert.equal(packed.name, "apex-packed-surface-fixture");
		const violations = checkPackedProductSurface(extractedDirectory, { requireApexReadme: false });
		assert.deepEqual(violations, []);
	});
});
