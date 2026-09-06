import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const workflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const workflowDirectory = dirname(fileURLToPath(workflowUrl));

async function readWorkflow() {
	const source = await readFile(workflowUrl, "utf8");
	return { source, workflow: parse(source) };
}

test("release workflow is tag-triggered, least-privilege, and publishes only Apex-owned packages", async () => {
	const { source, workflow } = await readWorkflow();
	const publish = workflow.jobs.publish;

	assert.deepEqual(workflow.on, { push: { tags: ["v*"] } });
	assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
	assert.equal(publish.env, undefined);
	assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN/);
	assert.equal(publish["timeout-minutes"], 30);
	assert.equal(publish.steps[0].with["persist-credentials"], false);
	for (const step of publish.steps.filter((candidate) => candidate.uses)) {
		assert.match(step.uses, /@[0-9a-f]{40}$/);
	}
	assert.equal((source.match(/publish-release-artifact\.mjs/g) ?? []).length, 2);
	assert.match(publish.steps.find((step) => step.name === "Publish Apex Code agent core").run, /"\$\{\{ steps\.release\.outputs\.tag \}\}"$/g);
	assert.match(publish.steps.find((step) => step.name === "Publish Apex Code CLI").run, /"\$\{\{ steps\.release\.outputs\.tag \}\}"$/g);
});

test("release derives the npm dist-tag through the tested selector, not inline shell", async () => {
	// Inline shell in a workflow is the one thing here no test can exercise, and a
	// release is the one place a mistake is unrecoverable. The rule lives in
	// scripts/apex/select-dist-tag.mjs, which has its own unit tests.
	const { workflow } = await readWorkflow();
	const releaseStep = workflow.jobs.publish.steps.find((step) => step.id === "release");
	assert.match(releaseStep.run, /node scripts\/apex\/select-dist-tag\.mjs "\$version" apex-code apex-code-agent-core/);
	assert.match(releaseStep.run, /echo "tag=\$\{tag\}"/);
	assert.doesNotMatch(releaseStep.run, /tag=next/);
});

test("release environment reference is present for external deployment-protection configuration (task 12.13)", async () => {
	const { workflow } = await readWorkflow();
	// This can only assert the workflow *references* a named GitHub Environment
	// -- whether "npm" has required reviewers or a branch/tag deployment policy
	// configured is an external GitHub setting, not something a workflow file
	// can prove on its own. See docs/release-governance-checklist.md.
	assert.equal(workflow.jobs.publish.environment, "npm");
});

test("the frozen-package boundary check runs before any build/test/publish step (task 12.13)", async () => {
	const { workflow } = await readWorkflow();
	const steps = workflow.jobs.publish.steps;

	const frozenCheckIndex = steps.findIndex((step) => step.run?.includes("scripts/apex/check-frozen-packages.mjs"));
	assert.notEqual(frozenCheckIndex, -1, "expected a frozen-package boundary check step");

	const buildIndex = steps.findIndex((step) => step.name === "Build");
	const firstPublishIndex = steps.findIndex((step) => step.run?.includes("publish-release-artifact.mjs"));
	assert.ok(frozenCheckIndex < buildIndex, "frozen boundary must be checked before build");
	assert.ok(frozenCheckIndex < firstPublishIndex, "frozen boundary must be checked before publish");
});

test("release workflow validates tag identity and clean-installs the published CLI", async () => {
	const { source, workflow } = await readWorkflow();
	const commands = workflow.jobs.publish.steps.map((step) => step.run).filter(Boolean).join("\n");

	assert.match(commands, /node scripts\/apex\/validate-release-tag\.mjs/);
	assert.match(commands, /select-dist-tag\.mjs/);
	assert.match(commands, /npm ci --ignore-scripts/);
	assert.match(commands, /apt-get install .*fd-find ripgrep/s);
	assert.match(commands, /ln -s .*fdfind.*\/usr\/local\/bin\/fd/);
	assert.match(commands, /npm test/);
	assert.match(commands, /npm install --cache .*--prefer-online --ignore-scripts/);
	assert.match(commands, /rm -rf -- "\$scratch\/npm-cache"/);
	assert.match(commands, /for attempt in \{1\.\.60\}/);
	assert.match(commands, /apex-code" --version/);
	assert.match(source, /apex-code-agent-core@\$\{VERSION\}.*did not become visible/s);
});

test("packed-artifact identity and functional smoke gate runs before either publish step (ADR 0018, task 12.8)", async () => {
	const { workflow } = await readWorkflow();
	const steps = workflow.jobs.publish.steps;

	const gateIndex = steps.findIndex((step) => step.run?.includes("scripts/apex/packed-product-surface.mjs"));
	assert.notEqual(gateIndex, -1, "expected a packed-product-surface gate step");
	assert.match(steps[gateIndex].run, /--smoke\b/);

	const firstPublishIndex = steps.findIndex((step) => step.run?.includes("publish-release-artifact.mjs"));
	assert.notEqual(firstPublishIndex, -1, "expected a publish step");
	assert.ok(gateIndex < firstPublishIndex, "the packed-artifact gate must run before publication, not after");
});

test("production dependency vulnerability audit and SBOM generation are required release gates (task 12.11)", async () => {
	const { workflow } = await readWorkflow();
	const steps = workflow.jobs.publish.steps;
	const commands = steps.map((step) => step.run).filter(Boolean).join("\n");

	assert.match(commands, /npm audit --omit=dev --audit-level=high/);
	assert.match(commands, /node scripts\/apex\/generate-sbom\.mjs/);

	const auditIndex = steps.findIndex((step) => step.run?.includes("npm audit"));
	const publishIndex = steps.findIndex((step) => step.run?.includes("publish-release-artifact.mjs"));
	assert.ok(auditIndex < publishIndex, "the vulnerability audit must run before publication");

	const uploadNames = steps.filter((step) => step.uses?.includes("upload-artifact")).map((step) => step.with?.name);
	assert.ok(uploadNames.includes("sbom"));
	assert.ok(uploadNames.includes("release-evidence"));
	assert.ok(uploadNames.includes("third-party-licenses"));
});

test("third-party license report is scoped to the packed production install, not the monorepo's own devDependencies (task 12.11)", async () => {
	const { workflow } = await readWorkflow();
	const steps = workflow.jobs.publish.steps;

	const licenseIndex = steps.findIndex((step) => step.run?.includes("generate:license-report"));
	assert.notEqual(licenseIndex, -1, "expected a license-report step");
	assert.match(steps[licenseIndex].run, /--node-modules ".*packed-product-surface\/smoke-install\/node_modules"/);

	const gateIndex = steps.findIndex((step) => step.run?.includes("scripts/apex/packed-product-surface.mjs"));
	assert.ok(gateIndex < licenseIndex, "the scratch install must exist before the license report reads it");
});

test("post-publication registry verification runs after both publish steps with the tag's commit SHA (ADR 0018, task 12.9)", async () => {
	const { workflow } = await readWorkflow();
	const steps = workflow.jobs.publish.steps;

	const verifyIndex = steps.findIndex((step) => step.run?.includes("scripts/apex/verify-published-release.mjs"));
	assert.notEqual(verifyIndex, -1, "expected a verify-published-release step");
	assert.match(steps[verifyIndex].run, /--release-manifest/);
	assert.match(steps[verifyIndex].run, /--install-directory/);

	const lastPublishIndex = steps.map((step) => step.run?.includes("publish-release-artifact.mjs") ?? false).lastIndexOf(true);
	assert.ok(verifyIndex > lastPublishIndex, "registry verification must run after both packages are published");
});

test("macOS verification job depends on publish, runs on the other supported platform, and never re-publishes", async () => {
	const { source, workflow } = await readWorkflow();
	const macJob = workflow.jobs["verify-macos-install"];

	assert.ok(macJob, "expected a verify-macos-install job");
	assert.equal(macJob["runs-on"], "macos-latest");
	assert.equal(macJob.needs, "publish");
	assert.equal(workflow.jobs.publish.outputs?.version, "${{ steps.release.outputs.version }}");

	const macCommands = macJob.steps.map((step) => step.run).filter(Boolean).join("\n");
	assert.match(macCommands, /npm install --global .*--prefer-online .*--ignore-scripts .*apex-code@/);
	assert.match(macCommands, /"\$scratch\/global\/bin\/apex-code" --version/);
	assert.doesNotMatch(macCommands, /publish-release-artifact\.mjs/);

	// The exactly-twice publish assertion above only inspected the publish job's
	// steps; assert it holds for the whole file too, so a publish call hidden in
	// the new job would fail this test even if the publish-job-scoped one above
	// were ever loosened.
	assert.equal((source.match(/publish-release-artifact\.mjs/g) ?? []).length, 2);
});

test("standalone binaries are built and hashed before npm publication, then released only after macOS verification", async () => {
	const { workflow } = await readWorkflow();
	const publish = workflow.jobs.publish;
	const steps = publish.steps;
	const binaryBuildIndex = steps.findIndex((step) => step.run?.includes("scripts/build-binaries.sh"));
	const checksumIndex = steps.findIndex((step) => step.run?.includes("scripts/apex/prepare-binary-release.mjs"));
	const binarySmokeIndex = steps.findIndex((step) => step.run?.includes("binaries/linux-x64/apex-code"));
	const firstPublishIndex = steps.findIndex((step) => step.run?.includes("publish-release-artifact.mjs"));

	assert.notEqual(binaryBuildIndex, -1, "expected a standalone binary build");
	assert.notEqual(checksumIndex, -1, "expected checksum manifest generation");
	assert.notEqual(binarySmokeIndex, -1, "expected a local binary smoke test");
	assert.ok(binaryBuildIndex < checksumIndex && checksumIndex < binarySmokeIndex);
	assert.ok(binarySmokeIndex < firstPublishIndex, "binary verification must precede npm publication");

	const release = workflow.jobs["publish-binaries"];
	assert.ok(release, "expected a final GitHub Release job");
	assert.deepEqual(release.needs, ["publish", "verify-macos-install"]);
	assert.deepEqual(release.permissions, { contents: "write" });
	assert.match(release.steps.map((step) => step.run).filter(Boolean).join("\n"), /gh release create/);
	assert.match(release.steps.map((step) => step.run).filter(Boolean).join("\n"), /SHA256SUMS/);
	for (const step of release.steps.filter((candidate) => candidate.uses)) {
		assert.match(step.uses, /@[0-9a-f]{40}$/);
	}
});

test("the standalone release job names the repository, having never checked it out", async () => {
	// It downloads an artifact and nothing else, so `gh` has no git remote to infer
	// from. Three consecutive releases failed here with "fatal: not a git repository"
	// after their npm publish had already succeeded.
	const { workflow } = await readWorkflow();
	const job = workflow.jobs["publish-binaries"];
	assert.ok(job, "expected a publish-binaries job");
	assert.equal(
		job.steps.some((step) => step.uses?.startsWith("actions/checkout")),
		false,
		"this assertion only matters while the job has no checkout",
	);
	const create = job.steps.find((step) => step.run?.includes("gh release create"));
	assert.match(create.run, /--repo "\$\{GITHUB_REPOSITORY\}"/);
});


test("all npm publication uses the tested artifact manifest tarballs", async () => {
	const { source, workflow } = await readWorkflow();
	const steps = workflow.jobs.publish.steps;
	const packStep = steps.find((step) => step.run?.includes("packed-product-surface.mjs"));
	assert.match(packStep.run, /--git-head "\$\{GITHUB_SHA\}"/);
	assert.match(packStep.run, /--workflow-identity/);
	assert.match(packStep.run, /--manifest-out/);
	assert.match(packStep.run, /--standalone-directory/);

	const publishSteps = steps.filter((step) => step.run?.includes("publish-release-artifact.mjs"));
	assert.equal(publishSteps.length, 2);
	for (const step of publishSteps) {
		assert.equal(step["working-directory"], undefined);
		assert.match(step.run, /publish-release-artifact\.mjs/);
		assert.match(step.run, /release-artifacts\.json/);
	}
	assert.doesNotMatch(source, /working-directory: packages\/(?:agent|coding-agent)[\s\S]*?npm publish/);
});

test("post-publication gates consume the retained release artifact manifest", async () => {
	const { workflow } = await readWorkflow();
	const commands = workflow.jobs.publish.steps.map((step) => step.run).filter(Boolean).join("\n");
	assert.match(commands, /generate-sbom\.mjs --release-manifest/);
	assert.match(commands, /generate:license-report.*--release-manifest/);
	assert.match(commands, /verify-published-release\.mjs.*--release-manifest/s);
	const verifierSource = await readFile(new URL("./apex/verify-published-release.mjs", import.meta.url), "utf8");
	assert.match(verifierSource, /"audit", "signatures", "--json", "--include-attestations", "--ignore-scripts"/);
	const standaloneUpload = workflow.jobs.publish.steps.find((step) => step.with?.name === "standalone-release-assets");
	assert.match(standaloneUpload.with.path, /release-artifacts\.json/);
	assert.match(workflow.jobs["publish-binaries"].steps.map((step) => step.run).filter(Boolean).join("\n"), /release-artifacts\.json/);
});

test("release.yml is the repository's only release-writing authority and no obsolete pi artifact can publish", async () => {
	const files = (await readdir(workflowDirectory)).filter((file) => /\.ya?ml$/.test(file));
	const writers = [];
	for (const file of files) {
		const source = await readFile(resolve(workflowDirectory, file), "utf8");
		const hasReleaseWrite = /publish-release-artifact\.mjs|npm publish|gh release (?:create|delete|edit|upload)|id-token:\s*write/.test(source);
		if (hasReleaseWrite) writers.push(file);
		if (basename(file) !== "release.yml") {
			assert.equal(hasReleaseWrite, false, `${file} must not retain release publication authority`);
		}
	}
	assert.deepEqual(writers, ["release.yml"]);
	const releaseSource = await readFile(workflowUrl, "utf8");
	assert.doesNotMatch(releaseSource, /(?:^|[\s/])pi-(?:coding-agent|agent|darwin|linux|windows|\$\{VERSION\}-source)/m);
});


/**
 * RI-B8: `actions/upload-artifact` preserves hierarchy relative to the least
 * common ancestor of everything its `path:` block matches, so mixing two
 * sibling directories silently re-roots every downloaded file one level deeper.
 * The existing workflow tests are regex assertions over the source and cannot
 * see that, so this materialises the real layout on disk instead: build what
 * the publish job produces, apply upload-artifact's LCA rule, then run the
 * final job's actual shell block against the result with `gh` stubbed.
 */
function leastCommonAncestor(paths) {
	const split = paths.map((path) => path.split("/"));
	const [first, ...rest] = split;
	let common = first.length;
	for (const candidate of rest) {
		let index = 0;
		while (index < common && index < candidate.length && candidate[index] === first[index]) index += 1;
		common = index;
	}
	return first.slice(0, common).join("/");
}

function matchUploadPattern(pattern, files) {
	if (!pattern.includes("*")) return files.filter((file) => file === pattern);
	const expression = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
	return files.filter((file) => expression.test(file));
}

test("the standalone artifact survives upload/download with the layout the release job actually reads", async () => {
	const { createReleaseArtifactRecord, REQUIRED_STANDALONE_ARTIFACTS, writeReleaseArtifactManifest } =
		await import("./apex/packed-product-surface.mjs");
	const { prepareBinaryRelease } = await import("./apex/prepare-binary-release.mjs");
	const { workflow } = await readWorkflow();

	const scratch = await mkdtemp(join(tmpdir(), "apex-release-layout-"));
	try {
		// 1. Reproduce what the publish job leaves in ${RUNNER_TEMP}.
		const runnerTemp = join(scratch, "runner-temp");
		const binaries = join(runnerTemp, "binaries");
		const packedSurface = join(runnerTemp, "packed-product-surface");
		await mkdir(binaries, { recursive: true });
		await mkdir(packedSurface, { recursive: true });
		for (const [index, filename] of REQUIRED_STANDALONE_ARTIFACTS.entries()) {
			await writeFile(join(binaries, filename), `standalone-archive-${index}`);
		}
		await prepareBinaryRelease(binaries);
		await writeFile(join(binaries, "artifact-identity.sha256"), "0".repeat(64));

		const identity = {
			expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
			workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v9.9.9",
		};
		const records = [];
		for (const [index, name] of ["apex-code-agent-core", "apex-code"].entries()) {
			const tarballPath = join(packedSurface, `pkg-${index}.tgz`);
			await writeFile(tarballPath, `tested-bytes-${index}`);
			records.push(createReleaseArtifactRecord({ tarballPath, packed: { name, version: "9.9.9" }, ...identity }));
		}
		writeReleaseArtifactManifest(join(packedSurface, "release-artifacts.json"), records, { standaloneDirectory: binaries });

		// 1b. Replay whatever pure `cp`/`mv` staging the publish job does before
		//     the upload, so the layout under test is the workflow's, not this
		//     test's assumption about it.
		const isStagingStep = (step) =>
			typeof step.run === "string" &&
			step.run
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#") && !line.startsWith("set -"))
				.every((line) => /^(?:cp|mv|mkdir) /.test(line));
		const uploadIndex = workflow.jobs.publish.steps.findIndex((step) => step.with?.name === "standalone-release-assets");
		for (const step of workflow.jobs.publish.steps.slice(0, uploadIndex).filter(isStagingStep)) {
			const staged = spawnSync("bash", ["-c", step.run], {
				encoding: "utf8",
				env: { ...process.env, RUNNER_TEMP: runnerTemp },
			});
			assert.equal(staged.status, 0, `staging step "${step.name}" failed:\n${staged.stderr}`);
		}

		// 2. Apply actions/upload-artifact's documented rooting rule to the
		//    workflow's real `path:` block.
		const uploadStep = workflow.jobs.publish.steps.find((step) => step.with?.name === "standalone-release-assets");
		assert.ok(uploadStep, "expected a standalone-release-assets upload");
		const patterns = uploadStep.with.path
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => line.replaceAll("${{ runner.temp }}", runnerTemp));

		const present = (await readdir(runnerTemp, { recursive: true, withFileTypes: true }))
			.filter((entry) => entry.isFile())
			.map((entry) => `${entry.parentPath}/${entry.name}`);
		const matched = [...new Set(patterns.flatMap((pattern) => matchUploadPattern(pattern, present)))];
		for (const pattern of patterns) {
			assert.notEqual(matchUploadPattern(pattern, present).length, 0, `upload path matched nothing: ${pattern} (if-no-files-found: error)`);
		}
		const root = leastCommonAncestor(matched.map((file) => dirname(file)));

		const workspace = join(scratch, "workspace");
		for (const file of matched) {
			const destination = join(workspace, "release-assets", file.slice(root.length + 1));
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(file, destination);
		}

		// 3. Run the final job's real shell block against that download.
		const releaseJob = workflow.jobs["publish-binaries"];
		const createStep = releaseJob.steps.find((step) => step.run?.includes("gh release create"));
		assert.ok(createStep, "expected a gh release create step");
		const script = createStep.run.replaceAll("${{ needs.publish.outputs.version }}", "9.9.9");
		assert.doesNotMatch(script, /\$\{\{/, "the layout test cannot evaluate unexpanded workflow expressions");

		const stubDirectory = join(scratch, "stub");
		await mkdir(stubDirectory, { recursive: true });
		const ghLog = join(scratch, "gh-args.json");
		await writeFile(
			join(stubDirectory, "gh"),
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o755 },
		);

		const result = spawnSync("bash", ["-c", script], {
			cwd: workspace,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${stubDirectory}:${process.env.PATH}`,
				GH_TOKEN: "stub",
				VERSION: "9.9.9",
				GITHUB_REF_NAME: "v9.9.9",
				GITHUB_REF: "refs/tags/v9.9.9",
				GITHUB_REPOSITORY: "Fchery87/apex-code",
				GITHUB_SHA: identity.expectedGitCommit,
			},
		});
		const downloaded = (await readdir(join(workspace, "release-assets"), { recursive: true, withFileTypes: true }))
			.filter((entry) => entry.isFile())
			.map((entry) => `release-assets/${relative(join(workspace, "release-assets"), join(entry.parentPath, entry.name))}`)
			.sort();
		assert.equal(
			result.status,
			0,
			`final release job failed against the real downloaded layout (upload root ${root}):\n` +
				`${downloaded.join("\n")}\n---stdout---\n${result.stdout}\n---stderr---\n${result.stderr}`,
		);

		const ghArgs = JSON.parse(await readFile(ghLog, "utf8"));
		assert.ok(ghArgs.includes("release-assets/SHA256SUMS"), `gh was not given SHA256SUMS: ${JSON.stringify(ghArgs)}`);
		for (const filename of REQUIRED_STANDALONE_ARTIFACTS) {
			assert.ok(
				ghArgs.includes(`release-assets/${filename}`),
				`gh was not given ${filename} -- an unexpanded glob would silently upload a partial release: ${JSON.stringify(ghArgs)}`,
			);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});


// RI-B3: docs/specs/2026-08-16-production-graduation-and-release-integrity.md
// requires a *prepublication* packed install and real functional smoke on both
// supported platforms (ADR 0005: Linux and macOS). The Ubuntu publisher runs
// one; before this, macOS only ran `apex-code --version` after the publish job
// had already pushed both packages to the registry.
test("a real macOS packed functional smoke gates publication, not just a post-publish --version check", async () => {
	const { workflow } = await readWorkflow();
	const publish = workflow.jobs.publish;
	const needs = [publish.needs].flat().filter(Boolean);

	const macGates = needs
		.map((name) => [name, workflow.jobs[name]])
		.filter(([, job]) => job && `${job["runs-on"]}`.startsWith("macos"));
	assert.notEqual(macGates.length, 0, `publish must depend on a macOS job; it depends on ${JSON.stringify(needs)}`);

	const [name, macGate] = macGates[0];
	const commands = macGate.steps.map((step) => step.run).filter(Boolean).join("\n");
	assert.match(commands, /scripts\/apex\/packed-product-surface\.mjs/, `${name} must run the packed-artifact gate`);
	assert.match(commands, /--smoke\b/, `${name} must run the real functional smoke, not only --version`);
	assert.doesNotMatch(commands, /publish-release-artifact\.mjs/, `${name} must never publish`);
	assert.equal([macGate.needs].flat().filter(Boolean).includes("publish"), false, `${name} must run before publication`);

	// The Ubuntu publisher still carries the other supported platform's smoke.
	assert.match(publish.steps.map((step) => step.run).filter(Boolean).join("\n"), /packed-product-surface\.mjs[\s\S]*?--smoke/);
});
