import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

describe("--api-key warning (HR.8)", () => {
	test("still accepts the key, and warns that the key leaks to shell history and process listings", () => {
		const result = parseArgs(["--api-key", "sk-test-123", "hello"]);
		expect(result.apiKey).toBe("sk-test-123");
		const warning = result.diagnostics.find((diagnostic) => diagnostic.type === "warning");
		expect(warning?.message).toMatch(/shell history/);
		expect(warning?.message).toMatch(/\/login/);
	});

	test("a run without --api-key produces no such warning", () => {
		const result = parseArgs(["hello"]);
		expect(result.diagnostics.some((diagnostic) => /shell history/.test(diagnostic.message))).toBe(false);
	});
});
