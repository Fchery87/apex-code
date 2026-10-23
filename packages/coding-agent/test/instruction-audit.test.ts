import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditInstructions } from "../src/core/instruction-audit.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

describe("instruction audit", () => {
	it("reports a path named in an instruction file that does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-audit-"));
		directories.push(dir);
		writeFileSync(join(dir, "AGENTS.md"), "Read docs/missing.md before editing.\n");
		const findings = auditInstructions(dir);
		expect(
			findings.some((finding) => finding.kind === "missing-path" && finding.text.includes("docs/missing.md")),
		).toBe(true);
	});

	it("reports two instruction files that give the same command different arguments", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-audit-"));
		directories.push(dir);
		writeFileSync(join(dir, "AGENTS.md"), "Run `npm test` after a change.\n");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "AGENTS.md"), "Run `npm test -- --watch` after a change.\n");
		const findings = auditInstructions(dir);
		expect(findings.some((finding) => finding.kind === "contradiction")).toBe(true);
	});

	it("reports a command that is not on PATH", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-audit-"));
		directories.push(dir);
		writeFileSync(join(dir, "AGENTS.md"), "Run `apex-code-missing-command` after a change.\n");
		const findings = auditInstructions(dir);
		expect(
			findings.some((finding) => finding.kind === "missing-command" && finding.text === "apex-code-missing-command"),
		).toBe(true);
	});

	it("writes no file", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-audit-"));
		directories.push(dir);
		writeFileSync(join(dir, "AGENTS.md"), "Read docs/missing.md before editing.\n");
		const before = readdirSync(dir);
		auditInstructions(dir);
		expect(readdirSync(dir)).toEqual(before);
	});
});
