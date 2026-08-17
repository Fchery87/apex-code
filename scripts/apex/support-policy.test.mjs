import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SECURITY.md names the accountable maintainer and links the support/runbook docs (task 12.12)", async () => {
	const security = await read("SECURITY.md");
	assert.match(security, /Frantz Chery/);
	assert.match(security, /docs\/support\.md/);
	assert.match(security, /docs\/release-integrity-runbook\.md/);
	assert.match(security, /best-effort/i);
});

test("docs/support.md publishes the maintainer, targets, supported-version line, platform matrix, and succession policy", async () => {
	const support = await read("docs/support.md");
	assert.match(support, /Frantz Chery/);
	assert.match(support, /best-effort/i);
	assert.match(support, /only the latest non-deprecated Apex Code prerelease receives security support/);
	assert.match(support, /Node\.js `>=22\.19`/);
	assert.match(support, /Linux and macOS/);
	assert.match(support, /Windows.*sandbox enforcement is\s*\n?\s*\*\*not\*\*/is);
	assert.match(support, /ADR 0014/);
	assert.match(support, /succession/i);
	assert.match(support, /release-integrity-runbook\.md/);
});

test("the release governance checklist records external settings without claiming they are enabled (task 12.13)", async () => {
	const checklist = await read("docs/release-governance-checklist.md");
	assert.match(checklist, /not a claim that they already are/);
	assert.match(checklist, /evidence that\s+any item below is enabled/);
	assert.match(checklist, /Branch protection on `main`/);
	assert.match(checklist, /Trusted Publishing/);
	assert.match(checklist, /NPM_TOKEN/);
	assert.match(checklist, /Private vulnerability reporting/);
	assert.match(checklist, /Dependabot alerts/);
});

test("the packed npm README links to the published support policy and security policy", async () => {
	const readme = await read("packages/coding-agent/README.md");
	assert.match(readme, /best-effort/i);
	assert.match(readme, /github\.com\/Fchery87\/apex-code\/blob\/main\/docs\/support\.md/);
	assert.match(readme, /github\.com\/Fchery87\/apex-code\/blob\/main\/SECURITY\.md/);
});
