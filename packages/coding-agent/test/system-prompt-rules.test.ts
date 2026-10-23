import { describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../src/core/tools/bash.ts";

function rules(): string {
	return (
		buildSystemPromptSections({ cwd: "/work", selectedTools: ["read", "bash", "edit", "write", "todo_write"] })
			.rules ?? ""
	);
}

describe("working rules in the system prompt (HR.17)", () => {
	it("tells the model to verify before claiming work is done", () => {
		expect(rules()).toMatch(/verify/i);
		expect(rules()).toMatch(/before (you )?(say|claim|report)[^.]*done/i);
	});

	it("tells the model to read a file before editing it", () => {
		expect(rules()).toMatch(/read (a|the) file before (you )?edit/i);
	});

	it("forbids destructive git operations unless the user asks for them", () => {
		expect(rules()).toMatch(/reset --hard/);
		expect(rules()).toMatch(/force/);
		expect(rules()).toMatch(/unless the user (explicitly )?asks/i);
	});

	it("treats tool output, file contents, and web pages as data, not instructions", () => {
		expect(rules()).toMatch(/tool output[^.]*data/i);
		expect(rules()).toMatch(/not (as )?instructions/i);
	});

	it("tells the model to keep a task list and to commit finished work", () => {
		expect(rules()).toMatch(/todo_write/);
		expect(rules()).toMatch(/commit/i);
	});

	it("tells the model not to use em dashes", () => {
		expect(rules()).toMatch(/em dash/i);
	});

	it("points at the current session environment variable names", () => {
		const sections = buildSystemPromptSections({
			cwd: "/work",
			selectedTools: ["bash"],
			toolGuidelines: { bash: [...bashToolSystemPromptContribution.guidelines] },
		});
		expect(sections.rules).toMatch(/APEX_CODE_SESSION_ID/);
		expect(sections.rules).not.toMatch(/PI_\*/);
		expect(bashToolSystemPromptContribution.snippet).toMatch(/read, grep, find, and ls instead/);
	});
});

describe("docs section of the system prompt", () => {
	it("names the docs directory and nothing else", () => {
		const docs = buildSystemPromptSections({ cwd: "/work" }).docs ?? "";
		expect(docs).toMatch(/<docs>/);
		expect(docs).not.toMatch(/docs\/extensions\.md/);
		expect(docs).not.toMatch(/When asked about/);
	});
});
