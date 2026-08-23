import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("built-in slash commands", () => {
	it("exposes the configuration index", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "config",
			description: "Open the configuration index",
		});
	});
});
