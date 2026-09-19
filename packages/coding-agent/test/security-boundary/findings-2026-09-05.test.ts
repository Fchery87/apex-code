import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const TABLE = join(REPO, "docs", "research", "2026-09-05-apex-code-audit-review-and-architecture-critique.md");

/**
 * The 2026-09-05 audit ran probes and kept them outside the test tree. A probe no suite runs
 * decays into a claim about a commit that has since moved, so the spec asked for one committed
 * probe per row of its confirmed-findings table.
 *
 * Writing ten fresh probes would have duplicated ten that already exist and already run. What
 * was missing was not coverage; it was the binding between a row and the test that answers it.
 * This index is that binding, and it is the thing `npm test` re-answers.
 *
 * It reads the table out of the research document rather than restating it, so a row added
 * there with no disposition here fails, which is the direction that matters.
 *
 * Nine rows have no subject left. ADR 0032 deleted the OS boundary, its supervisor, its
 * credential proxy, its platform backends, and its projection planner. A probe for any of them
 * would exercise deleted code and pass for the wrong reason, so they are retired against the
 * ADR that retired them rather than answered.
 */
type Disposition = { kind: "probed"; file: string; test: string } | { kind: "retired"; by: string; note: string };

const RETIRED_BY_ADR_0032 = "docs/adr/0032-no-built-in-sandbox.md";

const DISPOSITIONS: Record<string, Disposition> = {
	"Project permission files bypass trust": {
		kind: "probed",
		file: "packages/coding-agent/test/security-boundary/project-permission-trust.test.ts",
		test: "a checkout supplying a grant must not start trusted",
	},
	"A write-capable session can rewrite authorization state": {
		kind: "probed",
		file: "packages/coding-agent/test/startup-trust.test.ts",
		test: "freezes project authorization against file and symlink replacement",
	},
	"Eager project MCP runs while the project is untrusted": {
		kind: "probed",
		file: "packages/coding-agent/test/startup-trust.test.ts",
		test: "does not create or warm untrusted eager project MCP",
	},
	"Raw CLI argument scanning can skip sandbox startup": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "There is no sandbox startup to skip. The parse-once property the finding motivated is kept, and `test/args.test.ts` covers it.",
	},
	"`@` path aliases bypass path rules": {
		kind: "probed",
		file: "packages/coding-agent/test/permissions/canonical-authorization.test.ts",
		test: "uses @ and symlink aliases as the executed target",
	},
	"Symlink aliases bypass target-specific path rules": {
		kind: "probed",
		file: "packages/coding-agent/test/permissions/canonical-authorization.test.ts",
		test: "refuses a write whose authorized existing target is swapped for a symlink",
	},
	"Mixed Bash commands can defeat scoped denies": {
		kind: "probed",
		file: "packages/coding-agent/test/permissions/canonical-authorization.test.ts",
		test: "does not let a blanket allow erase a scoped deny in a mixed command",
	},
	"Quoted whitespace is lost in exact Bash approvals": {
		kind: "probed",
		file: "packages/coding-agent/test/permissions/canonical-authorization.test.ts",
		test: "preserves exact quoted whitespace in approvals",
	},
	"Generated literal path grants can become globs": {
		kind: "probed",
		file: "packages/coding-agent/test/permissions/canonical-authorization.test.ts",
		test: "does not treat literal glob characters in an exact approval as patterns",
	},
	"Verifier commands bypass the canonical permission gate": {
		kind: "probed",
		file: "packages/coding-agent/test/policy-authorization.test.ts",
		test: "blocks an exec command in plan mode even when the policy allows it",
	},
	"Formatters can mutate undeclared files and still report success": {
		kind: "probed",
		file: "packages/coding-agent/test/formatter-confinement.test.ts",
		test: "never reports passed when scope was violated",
	},
	"Git credential helpers can execute repository configuration on the host": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "The credential proxy and its helper were deleted with the boundary.",
	},
	"Credential protocol input permits host confusion": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "The protocol parser it named went with the proxy. No credential path is brokered on any child's behalf any more.",
	},
	"Supervisor state writes follow workspace symlinks": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "There is no supervisor and no supervisor-owned state.",
	},
	"Custom host policy can be lost during sandbox launch": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "There is no sandbox launch for a policy snapshot to be lost during.",
	},
	"Linux escalation socket is missing inside the child": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "Escalation and the child it escalated into were deleted with the boundary.",
	},
	"macOS Seatbelt profile is workspace-writable": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "No Seatbelt profile is written, because nothing consumes one.",
	},
	"macOS escalation retains excess channels": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "The macOS backend and the escalation runner that held those channels were both deleted.",
	},
	"Directory projections expose parent siblings": {
		kind: "retired",
		by: RETIRED_BY_ADR_0032,
		note: "There is no projection planner; the workspace is the operator's to contain.",
	},
	"Release publication is not clearly bound to tested bytes": {
		kind: "probed",
		file: "scripts/release-workflow.test.mjs",
		test: "packed-artifact identity and functional smoke gate runs before either publish step",
	},
};

/** The first column of every row in the document's "Confirmed findings" table. */
function tableRows(): string[] {
	const markdown = readFileSync(TABLE, "utf8");
	const heading = markdown.indexOf("## Confirmed findings");
	expect(heading, "the confirmed-findings table moved or was renamed").toBeGreaterThan(-1);
	const rest = markdown.slice(heading);
	const end = rest.indexOf("\n## ", 1);
	const section = end === -1 ? rest : rest.slice(0, end);
	return section
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|")[1]?.trim() ?? "")
		.filter((cell) => cell.length > 0 && cell !== "Area" && !/^-+$/.test(cell));
}

describe("every 2026-09-05 confirmed finding has a disposition", () => {
	it("indexes every row the research document still lists", () => {
		const missing = tableRows().filter((row) => DISPOSITIONS[row] === undefined);
		expect(missing, `add a disposition for:\n${missing.join("\n")}`).toEqual([]);
	});

	it("indexes no row the research document no longer lists", () => {
		const rows = new Set(tableRows());
		expect(Object.keys(DISPOSITIONS).filter((row) => !rows.has(row))).toEqual([]);
	});

	it("points every probed row at a test that exists and still carries that name", () => {
		const broken: string[] = [];
		for (const [row, disposition] of Object.entries(DISPOSITIONS)) {
			if (disposition.kind !== "probed") continue;
			const path = join(REPO, disposition.file);
			if (!existsSync(path)) {
				broken.push(`${row}: ${disposition.file} does not exist`);
				continue;
			}
			if (!readFileSync(path, "utf8").includes(disposition.test)) {
				broken.push(`${row}: ${disposition.file} no longer contains "${disposition.test}"`);
			}
		}
		expect(broken, broken.join("\n")).toEqual([]);
	});

	it("points every retired row at the decision that retired it", () => {
		for (const [row, disposition] of Object.entries(DISPOSITIONS)) {
			if (disposition.kind !== "retired") continue;
			expect(existsSync(join(REPO, disposition.by)), `${row} names a missing ADR`).toBe(true);
			expect(disposition.note.length, `${row} retires with no reason`).toBeGreaterThan(20);
		}
	});

	it("names every probed path from the repository root, so one base resolves them all", () => {
		for (const disposition of Object.values(DISPOSITIONS)) {
			if (disposition.kind !== "probed") continue;
			expect(disposition.file.startsWith("packages/") || disposition.file.startsWith("scripts/")).toBe(true);
		}
	});

	it("retires a row only while the subsystem it named is actually gone", () => {
		// The retirements all rest on one fact. If the boundary ever returns, they stop being
		// retirements and become nine unanswered findings, and this is what says so.
		expect(existsSync(join(REPO, "packages", "coding-agent", "src", "core", "sandbox"))).toBe(false);
	});
});
