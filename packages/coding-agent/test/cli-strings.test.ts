import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

const argsSource = readFileSync(join(__dirname, "..", "src", "cli", "args.ts"), "utf8");

describe("user-facing strings name this project (HR.27)", () => {
	it("the --exclude-tools example names a tool that exists", () => {
		expect(argsSource).toContain("--exclude-tools ask_user");
		expect(argsSource).not.toContain("--exclude-tools ask_question");
	});

	it("/bug describes Apex Code, not Pi", () => {
		const bug = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "bug");
		expect(bug?.description).toBe("Report a bug in Apex Code");
	});
});
