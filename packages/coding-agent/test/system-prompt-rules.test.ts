import { describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";

function rules(): string {
	return buildSystemPromptSections({ cwd: "/work", selectedTools: ["read", "bash", "edit", "write"] }).rules ?? "";
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
});
