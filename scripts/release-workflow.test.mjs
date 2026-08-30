import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const workflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);

async function readWorkflow() {
	const source = await readFile(workflowUrl, "utf8");
	return { source, workflow: parse(source) };
}

test("release workflow is tag-triggered, least-privilege, and publishes only Apex-owned packages", async () => {
	const { source, workflow } = await readWorkflow();
	const publish = workflow.jobs.publish;
	const directories = publish.steps.map((step) => step["working-directory"]).filter(Boolean);

	assert.deepEqual(workflow.on, { push: { tags: ["v*"] } });
	assert.deepEqual(workflow.permissions, { contents: "read", "id-token": "write" });
	assert.equal(publish.env, undefined);
	assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN/);
	assert.equal(publish["timeout-minutes"], 30);
	assert.equal(publish.steps[0].with["persist-credentials"], false);
	for (const step of publish.steps.filter((candidate) => candidate.uses)) {
		assert.match(step.uses, /@[0-9a-f]{40}$/);
	}
	assert.deepEqual(directories, ["packages/agent", "packages/coding-agent"]);
	assert.equal((source.match(/npm publish --access public --provenance --tag "\$\{\{ steps.release.outputs.tag \}\}"/g) ?? []).length, 2);
	assert.match(publish.steps.find((step) => step.name === "Publish Apex Code agent core").run, /tag "\$\{\{ steps\.release\.outputs\.tag \}\}"/);
	assert.match(publish.steps.find((step) => step.name === "Publish Apex Code CLI").run, /tag "\$\{\{ steps\.release\.outputs\.tag \}\}"/);
});

test("release derives npm dist-tag from semver, using next only for prereleases", async () => {
	const { workflow } = await readWorkflow();
	const releaseStep = workflow.jobs.publish.steps.find((step) => step.id === "release");
	assert.match(releaseStep.run, /if \[{2} "\$version" == .*\]\]; then/);
	assert.match(releaseStep.run, /tag=next/);
	assert.match(releaseStep.run, /tag=latest/);
	assert.match(releaseStep.run, /echo "tag=\$\{tag\}"/);
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
	const firstPublishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));
	assert.ok(frozenCheckIndex < buildIndex, "frozen boundary must be checked before build");
	assert.ok(frozenCheckIndex < firstPublishIndex, "frozen boundary must be checked before publish");
});

test("release workflow validates tag identity and clean-installs the published CLI", async () => {
	const { source, workflow } = await readWorkflow();
	const commands = workflow.jobs.publish.steps.map((step) => step.run).filter(Boolean).join("\n");

	assert.match(commands, /node scripts\/apex\/validate-release-tag\.mjs/);
	assert.match(commands, /tag=latest/);
	assert.match(commands, /\$version" == \*-\*/);
	assert.match(commands, /npm ci --ignore-scripts/);
	assert.match(commands, /apt-get install .*fd-find ripgrep/s);
	assert.match(commands, /ln -s .*fdfind.*\/usr\/local\/bin\/fd/);
	assert.match(commands, /npm test/);
	assert.match(commands, /npm install --global .*--prefer-online .*--ignore-scripts .*apex-code@/);
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

	const firstPublishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));
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
	const publishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));
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
	assert.match(steps[verifyIndex].run, /apex-code-agent-core@\$\{VERSION\}/);
	assert.match(steps[verifyIndex].run, /apex-code@\$\{VERSION\}/);
	assert.match(steps[verifyIndex].run, /--git-head "\$\{GITHUB_SHA\}"/);

	const lastPublishIndex = steps.map((step) => step.run?.includes("npm publish") ?? false).lastIndexOf(true);
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
	assert.doesNotMatch(macCommands, /npm publish/);

	// The exactly-twice publish assertion above only inspected the publish job's
	// steps; assert it holds for the whole file too, so a publish call hidden in
	// the new job would fail this test even if the publish-job-scoped one above
	// were ever loosened.
	assert.equal((source.match(/npm publish --access public --provenance --tag "\$\{\{ steps.release.outputs.tag \}\}"/g) ?? []).length, 2);
});

test("standalone binaries are built and hashed before npm publication, then released only after macOS verification", async () => {
	const { workflow } = await readWorkflow();
	const publish = workflow.jobs.publish;
	const steps = publish.steps;
	const binaryBuildIndex = steps.findIndex((step) => step.run?.includes("scripts/build-binaries.sh"));
	const checksumIndex = steps.findIndex((step) => step.run?.includes("scripts/apex/prepare-binary-release.mjs"));
	const binarySmokeIndex = steps.findIndex((step) => step.run?.includes("binaries/linux-x64/apex-code"));
	const firstPublishIndex = steps.findIndex((step) => step.run?.includes("npm publish"));

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
