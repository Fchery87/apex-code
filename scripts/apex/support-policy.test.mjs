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
	assert.match(support, /only the latest non-deprecated Apex Code release receives security support/);
	assert.match(support, /Node\.js `>=22\.19`/);
	assert.match(support, /Linux and macOS/);
	assert.match(support, /ships no built-in sandbox/);
	assert.match(support, /ADR 0032/);
	assert.match(support, /ADR 0014/);
	assert.match(support, /succession/i);
	assert.match(support, /release-integrity-runbook\.md/);
});

test("the release governance checklist ticks nothing without dated evidence (task 12.13)", async () => {
	const checklist = await read("docs/release-governance-checklist.md");

	// This assertion used to require the page to claim nothing at all, which kept it honest
	// by keeping it empty. The items are now verifiable, so the invariant moved: a tick is a
	// dated observation of a live setting, never a guarantee that anything enforces it.
	assert.match(checklist, /A ticked box here means someone checked the live setting on the date/);
	assert.match(checklist, /Nothing below is self-maintaining/);

	assert.match(checklist, /Branch protection on `main`/);
	assert.match(checklist, /Trusted Publishing/);
	assert.match(checklist, /NPM_TOKEN/);
	assert.match(checklist, /Private vulnerability reporting/);
	assert.match(checklist, /Dependabot alerts/);

	// Every ticked box carries its own evidence line. A tick with nothing under it is the
	// failure this test exists to catch, and it is what the old "claim nothing" rule prevented
	// by forbidding ticks outright.
	const unevidenced = [];
	const lines = checklist.split("\n");
	for (const [index, line] of lines.entries()) {
		if (!/^\s*- \[x\] /.test(line)) continue;
		const block = [];
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			if (/^\s*- \[[ x]\] /.test(lines[cursor]) || lines[cursor].startsWith("#")) break;
			block.push(lines[cursor]);
		}
		const body = [line, ...block].join(" ");
		if (!/\*Verified \d{4}-\d{2}-\d{2}|\*Settled/.test(body)) unevidenced.push(line.trim());
	}
	assert.deepEqual(unevidenced, [], `these boxes are ticked with no evidence line:\n${unevidenced.join("\n")}`);

	// The two that cannot be settled from a checkout must say so rather than sit unexplained.
	assert.match(checklist, /Not settleable from a checkout/);
});

test("the packed npm README links to the published support policy and security policy", async () => {
	const readme = await read("packages/coding-agent/README.md");
	assert.match(readme, /best-effort/i);
	assert.match(readme, /github\.com\/Fchery87\/apex-code\/blob\/main\/docs\/support\.md/);
	assert.match(readme, /github\.com\/Fchery87\/apex-code\/blob\/main\/SECURITY\.md/);
});
