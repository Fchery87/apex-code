import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPublicWorkspacePackages } from "../release-packages.mjs";
import { generateAllSboms, generateSbomFor } from "./generate-sbom.mjs";
import { npmSpawnOptions } from "./npm-command.mjs";

const bothOwnedPackagesAreBuilt = getPublicWorkspacePackages().every((pkg) => existsSync(join(pkg.directory, "dist")));

test(
	"generates a real, non-empty CycloneDX SBOM with real hashes for each Apex-owned package (requires npm run build first)",
	{ skip: !bothOwnedPackagesAreBuilt },
	async () => {
		const outDir = await mkdtemp(join(tmpdir(), "apex-sbom-"));
		try {
			const written = generateAllSboms(outDir);
			assert.equal(written.length, 2);
			for (const entry of written) {
				assert.ok(entry.componentCount > 0, `${entry.name} SBOM has no components`);
				const { readFile } = await import("node:fs/promises");
				const document = JSON.parse(await readFile(entry.path, "utf8"));
				assert.equal(document.bomFormat, "CycloneDX");
				assert.ok(Array.isArray(document.components) && document.components.length > 0);
				// At least one real, hash-bearing dependency, proving this is a
				// genuine dependency-tree scan, not a stub or placeholder document.
				assert.ok(document.components.some((component) => Array.isArray(component.hashes) && component.hashes.length > 0));
			}
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	},
);

test("generateSbomFor refuses to treat an empty component list as evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-sbom-empty-"));
	try {
		// A minimal workspace root of its own -- npm sbom --workspace requires the
		// target to be a registered workspace of whatever `cwd` it runs from.
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture-root", version: "1.0.0", private: true, workspaces: ["pkg"] }, null, "\t"),
		);
		const packageDirectory = join(root, "pkg");
		await mkdir(packageDirectory, { recursive: true });
		// No dependencies at all -- exactly the silent zero-component case this
		// guard exists to catch (npm sbom still exits 0).
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "apex-sbom-empty-fixture", version: "1.0.0" }, null, "\t"),
		);
		spawnSync("npm", ["install", "--ignore-scripts"], npmSpawnOptions({ cwd: root }));

		assert.throws(
			() => generateSbomFor({ name: "apex-sbom-empty-fixture", directory: packageDirectory }, root),
			/no real dependency components/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
