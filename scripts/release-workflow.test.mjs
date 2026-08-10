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
	assert.equal((source.match(/npm publish --access public --provenance --tag next/g) ?? []).length, 2);
});

test("release workflow validates tag identity and clean-installs the published CLI", async () => {
	const { source, workflow } = await readWorkflow();
	const commands = workflow.jobs.publish.steps.map((step) => step.run).filter(Boolean).join("\n");

	assert.match(commands, /node scripts\/apex\/validate-release-tag\.mjs/);
	assert.match(commands, /npm ci --ignore-scripts/);
	assert.match(commands, /apt-get install .*fd-find ripgrep/s);
	assert.match(commands, /ln -s .*fdfind.*\/usr\/local\/bin\/fd/);
	assert.match(commands, /npm test/);
	assert.match(commands, /npm install --global .*--ignore-scripts .*apex-code@/);
	assert.match(commands, /apex-code" --version/);
	assert.match(source, /apex-code-agent-core@\$\{VERSION\}.*did not become visible/s);
});
