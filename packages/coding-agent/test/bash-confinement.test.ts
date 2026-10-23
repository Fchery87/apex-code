import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
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

	it("does not run the command when bash confinement is on and bwrap is absent", async () => {
		const previous = process.env.PATH;
		process.env.PATH = "";
		let ran = false;
		try {
			const tool = createBashToolDefinition("/tmp", {
				confinement: true,
				operations: {
					exec: async () => {
						ran = true;
						return { exitCode: 0 };
					},
				},
			});
			const result = await tool.execute("call-1", { command: "echo hi" }, undefined, undefined, {
				sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
			} as never);
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			expect(text).toMatch(/bwrap/);
			expect(ran).toBe(false);
		} finally {
			process.env.PATH = previous;
		}
	});
});
