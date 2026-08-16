import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectLicenseEntries, formatReport } from "./generate-license-report.mjs";

const script = fileURLToPath(new URL("./generate-license-report.mjs", import.meta.url));

async function writePackage(nodeModulesDir, name, manifest) {
	const dir = join(nodeModulesDir, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
}

async function symlinkDirectory(target, path) {
	await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "apex-license-report-"));
	const nodeModules = join(root, "node_modules");
	await mkdir(nodeModules, { recursive: true });
	await writePackage(nodeModules, "left-pad", { version: "1.3.0", license: "MIT" });
	await writePackage(nodeModules, "chalk", { version: "5.6.2", license: { type: "MIT" } });
	await writePackage(nodeModules, "@scope/thing", { version: "2.0.0", license: "Apache-2.0" });
	await writePackage(nodeModules, "no-license-field", { version: "0.1.0" });
	return root;
}

test("collects license entries from installed package.json files, including scoped packages", async () => {
	const root = await fixture();
	try {
		const entries = collectLicenseEntries(join(root, "node_modules"));
		const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));

		assert.deepEqual(byName["left-pad"], { name: "left-pad", version: "1.3.0", license: "MIT" });
		assert.deepEqual(byName.chalk, { name: "chalk", version: "5.6.2", license: "MIT" });
		assert.deepEqual(byName["@scope/thing"], { name: "@scope/thing", version: "2.0.0", license: "Apache-2.0" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports UNKNOWN rather than dropping a package with no license field", async () => {
	const root = await fixture();
	try {
		const entries = collectLicenseEntries(join(root, "node_modules"));
		const entry = entries.find((candidate) => candidate.name === "no-license-field");
		assert.ok(entry, "package with no license field should still appear in the report");
		assert.equal(entry.license, "UNKNOWN");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("excludes symlinked workspace packages through a canonicalized checkout path", async () => {
	const root = await fixture();
	const checkoutAlias = `${root}-alias`;
	try {
		await mkdir(join(root, "packages", "coding-agent"), { recursive: true });
		await writeFile(
			join(root, "packages", "coding-agent", "package.json"),
			JSON.stringify({ name: "apex-code", version: "0.0.3", license: "MIT" }),
		);
		await symlinkDirectory(join(root, "packages", "coding-agent"), join(root, "node_modules", "apex-code"));
		await symlinkDirectory(root, checkoutAlias);

		const entries = collectLicenseEntries(join(checkoutAlias, "node_modules"));
		assert.ok(
			!entries.some((entry) => entry.name === "apex-code"),
			"workspace package should be excluded from the third-party report",
		);
		assert.ok(entries.some((entry) => entry.name === "left-pad"), "real third-party packages still appear");
	} finally {
		await rm(checkoutAlias, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("formats a markdown table in the given entry order (sorting is collectLicenseEntries's job, not formatReport's)", () => {
	const report = formatReport([
		{ name: "alpha", version: "2.0.0", license: "ISC" },
		{ name: "zeta", version: "1.0.0", license: "MIT" },
	]);
	const alphaIndex = report.indexOf("| alpha ");
	const zetaIndex = report.indexOf("| zeta ");
	assert.ok(alphaIndex > 0 && zetaIndex > 0 && alphaIndex < zetaIndex);
	assert.match(report, /\| alpha \| 2\.0\.0 \| ISC \|/);
	assert.match(report, /2 packages\./);
});

test("collectLicenseEntries returns entries sorted by package name", async () => {
	const root = await fixture();
	try {
		const entries = collectLicenseEntries(join(root, "node_modules"));
		const names = entries.map((entry) => entry.name);
		assert.deepEqual(names, [...names].sort());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CLI --stdout prints a non-empty report without writing a file", async () => {
	const root = await fixture();
	try {
		const result = spawnSync(
			process.execPath,
			[script, "--node-modules", join(root, "node_modules"), "--stdout"],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Third-party dependency licenses/);
		assert.match(result.stdout, /left-pad/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("CLI default mode writes the report to --out", async () => {
	const root = await fixture();
	const out = join(root, "report.md");
	try {
		const result = spawnSync(process.execPath, [script, "--node-modules", join(root, "node_modules"), "--out", out], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		const { readFile } = await import("node:fs/promises");
		const content = await readFile(out, "utf-8");
		assert.match(content, /left-pad/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
