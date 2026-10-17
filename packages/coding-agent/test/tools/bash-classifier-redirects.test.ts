import { describe, expect, it } from "vitest";
import { classifyBashCommand } from "../../src/core/tools/bash-command-segments.ts";

describe("bash classifier: redirections that discard or merge output (HR.22)", () => {
	it.each([
		["npm test 2>&1", ["npm test 2>&1"]],
		["npm test >/dev/null", ["npm test >/dev/null"]],
		["npm test 2>/dev/null", ["npm test 2>/dev/null"]],
		["npm test &>/dev/null", ["npm test &>/dev/null"]],
		["npm test >&2", ["npm test >&2"]],
	])("keeps %s as one segment", (command, segments) => {
		expect(classifyBashCommand(command)).toEqual({ type: "segments", segments });
	});

	it.each(["cat x >file", "npm test 2>&1 >out.txt", "cat x > result.txt"])(
		"still refuses a redirection to a file: %s",
		(command) => {
			expect(classifyBashCommand(command).type).toBe("unparseable");
		},
	);

	it("a discard does not hide a following command", () => {
		expect(classifyBashCommand(">/dev/null; rm x")).toEqual({ type: "segments", segments: [">/dev/null", "rm x"] });
	});
});

describe("bash classifier: tilde inside a word is literal (HR.22)", () => {
	it("keeps HEAD~3 as one token", () => {
		expect(classifyBashCommand("git log HEAD~3")).toEqual({ type: "segments", segments: ["git log HEAD~3"] });
	});

	it.each(["cat ~/x", "FOO=~/x make", "a:~/x"])("refuses a word-initial or post-= or post-: tilde: %s", (command) => {
		expect(classifyBashCommand(command).type).toBe("unparseable");
	});
});
