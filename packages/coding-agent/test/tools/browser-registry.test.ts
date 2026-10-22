import { describe, expect, it } from "vitest";
import { createAllToolDefinitions, createAllTools } from "../../src/core/tools/index.ts";

const operations = { open: async () => ({ title: "", finalUrl: "", console: [] }) };

describe("browser registry opt-in", () => {
	it("omits browser from the default tool definitions", () => {
		const definitions = createAllToolDefinitions("/tmp");
		expect(definitions).not.toHaveProperty("browser");
	});

	it("adds browser when the option is set", () => {
		const definitions = createAllToolDefinitions("/tmp", { browser: { operations } });
		expect(definitions.browser?.name).toBe("browser");
	});

	it("omits the executable tool unless the option is set", () => {
		expect(createAllTools("/tmp")).not.toHaveProperty("browser");
		expect(createAllTools("/tmp", { browser: { operations } }).browser?.name).toBe("browser");
	});
});
