import { describe, expect, it } from "vitest";
import { confineBash } from "../src/core/tools/bash-confinement.ts";

describe("bash confinement", () => {
	it("does nothing when the setting is off", () => {
		const result = confineBash({ enabled: false, command: "echo hi", cwd: "/work", helperPath: undefined });
		expect(result).toEqual({ run: true, command: "echo hi" });
	});

	it("refuses when the setting is on and the helper is missing", () => {
		const result = confineBash({ enabled: true, command: "echo hi", cwd: "/work", helperPath: undefined });
		expect(result.run).toBe(false);
		expect(result.refusal).toMatch(/bwrap/);
	});
});
