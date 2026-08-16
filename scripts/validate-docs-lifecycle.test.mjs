import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validator = fileURLToPath(new URL("./validate-docs-lifecycle.mjs", import.meta.url));

const validRoadmap = `# Roadmap

| Phase | Name | State | Spec | Plan |
| --- | --- | --- | --- | --- |
| 4 | Tool surface | **landed** | [spec](specs/phase-4.md) | — |
| 10 | Reliability | **active** | [spec](specs/phase-10.md) | [plan](plans/phase-10.md) |
`;

const validContracts = `# Cross-phase contracts

| Contract | Status | Consumers | Settle by |
| --- | --- | --- | --- |
| Session entry schema | **Settled** — ADR 0006 | Phases 1, 5, 6 | — |

# 1. Session entry schema — settled

**Consumers:** Phases 1, 5, 6.
`;

async function writeFixture(overrides = {}) {
	const root = await mkdtemp(join(tmpdir(), "apex-doc-lifecycle-"));
	const files = {
		"docs/roadmap.md": validRoadmap,
		"docs/plans/phase-10.md": "# Phase 10 plan\n\n**Status:** Active — 1 of 2 tasks\n",
		"docs/specs/phase-4.md": "# Phase 4 spec\n\n## Deletion inventory\n\nNothing.\n",
		"docs/specs/phase-10.md": "# Phase 10 spec\n\n## Deletion inventory\n\nNothing.\n",
		"docs/architecture/contracts.md": validContracts,
		...overrides,
	};
	for (const [relativePath, contents] of Object.entries(files)) {
		const path = join(root, relativePath);
		await mkdir(join(path, ".."), { recursive: true });
		if (contents !== null) await writeFile(path, contents);
	}
	return root;
}

function runValidator(root) {
	return spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
}

async function withFixture(overrides, assertion) {
	const root = await writeFixture(overrides);
	try {
		await assertion(runValidator(root));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("accepts live plans, permanent specs, and settled cross-phase contracts", async () => {
	await withFixture({}, (result) => {
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Documentation lifecycle validation passed/);
	});
});

test("plans declare an early status and completed plans are deleted", async (t) => {
	await t.test("rejects a status after the opening document metadata", async () => {
		await withFixture(
			{ "docs/plans/phase-10.md": "# Phase 10 plan\n\nIntro.\n\nMore intro.\n\n**Status:** Active\n" },
			(result) => {
				assert.equal(result.status, 1);
				assert.match(result.stderr, /phase-10\.md: expected a \*\*Status:\*\* line within the first 5 lines/);
			},
		);
	});

	await t.test("rejects a completed plan", async () => {
		await withFixture(
			{ "docs/plans/phase-10.md": "# Phase 10 plan\n\n**Status:** Complete — all tasks done\n" },
			(result) => {
				assert.equal(result.status, 1);
				assert.match(result.stderr, /phase-10\.md: completed plans must be deleted/);
			},
		);
	});
});

test("roadmap plan links resolve to live plans and every live plan is linked", async (t) => {
	await t.test("rejects a missing linked plan", async () => {
		await withFixture({ "docs/plans/phase-10.md": null }, (result) => {
			assert.equal(result.status, 1);
			assert.match(result.stderr, /roadmap\.md: plan link does not exist: plans\/phase-10\.md/);
		});
	});

	await t.test("rejects an unlinked live plan", async () => {
		await withFixture({ "docs/roadmap.md": validRoadmap.replace("[plan](plans/phase-10.md)", "—") }, (result) => {
			assert.equal(result.status, 1);
			assert.match(result.stderr, /phase-10\.md: live plan is not linked from docs\/roadmap\.md/);
		});
	});
});

test("every permanent spec has a deletion inventory", async () => {
	await withFixture({ "docs/specs/phase-10.md": "# Phase 10 spec\n" }, (result) => {
		assert.equal(result.status, 1);
		assert.match(result.stderr, /phase-10\.md: expected a Deletion inventory section/);
	});
});

test("contract summary and sections agree and open deadlines have not passed", async (t) => {
	await t.test("rejects summary and section status disagreement", async () => {
		await withFixture(
			{ "docs/architecture/contracts.md": validContracts.replace("schema — settled", "schema — open") },
			(result) => {
				assert.equal(result.status, 1);
				assert.match(result.stderr, /Session entry schema: summary is settled but section is open/);
			},
		);
	});

	await t.test("rejects an open contract whose phase deadline has passed", async () => {
		const openContracts = `# Cross-phase contracts

| Contract | Status | Consumers | Settle by |
| --- | --- | --- | --- |
| Session entry schema | Open | Phases 1, 5, 6 | start of Phase 6 |

# 1. Session entry schema — open

**Settle by:** start of Phase 6.
`;
		await withFixture({ "docs/architecture/contracts.md": openContracts }, (result) => {
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Session entry schema: open deadline has passed \(Phase 6 is landed\)/);
		});
	});
});
