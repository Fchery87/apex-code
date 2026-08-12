import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { resolveEffectiveMode, resolvePermissionModeForStartup } from "../../src/core/permissions/startup.ts";

describe("parseArgs --permission-mode", () => {
	it("parses a valid mode", () => {
		const args = parseArgs(["--permission-mode", "plan"]);
		expect(args.permissionMode).toBe("plan");
		expect(args.diagnostics).toEqual([]);
	});

	it("parses --allowed-tools as a low-precedence permission default", () => {
		const args = parseArgs(["--allowed-tools", "read, grep"]);
		expect(args.allowedTools).toEqual(["read", "grep"]);
	});

	it("errors, listing valid modes, on an invalid value", () => {
		const args = parseArgs(["--permission-mode", "yolo"]);
		expect(args.permissionMode).toBeUndefined();
		expect(args.diagnostics).toHaveLength(1);
		expect(args.diagnostics[0].type).toBe("error");
		expect(args.diagnostics[0].message).toContain("yolo");
		for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]) {
			expect(args.diagnostics[0].message).toContain(mode);
		}
	});

	it("errors when no value is given", () => {
		const args = parseArgs(["--permission-mode"]);
		expect(args.permissionMode).toBeUndefined();
		expect(args.diagnostics).toHaveLength(1);
		expect(args.diagnostics[0].type).toBe("error");
	});

	it("errors rather than swallowing the next flag as its value", () => {
		const args = parseArgs(["--permission-mode", "--print"]);
		expect(args.permissionMode).toBeUndefined();
		expect(args.diagnostics).toHaveLength(1);
		expect(args.print).toBe(true);
	});
});

describe("resolvePermissionModeForStartup", () => {
	it("a non-interactive session with no explicit mode is refused, naming the valid modes", () => {
		const result = resolvePermissionModeForStartup({ interactive: false, requestedMode: undefined });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]) {
				expect(result.message).toContain(mode);
			}
		}
	});

	it("an interactive session with no explicit mode starts normally in default", () => {
		const result = resolvePermissionModeForStartup({ interactive: true, requestedMode: undefined });
		expect(result).toEqual({ ok: true, mode: "default" });
	});

	it("an explicit mode is honored for either interactive or non-interactive sessions", () => {
		expect(resolvePermissionModeForStartup({ interactive: false, requestedMode: "bypassPermissions" })).toEqual({
			ok: true,
			mode: "bypassPermissions",
		});
		expect(resolvePermissionModeForStartup({ interactive: true, requestedMode: "plan" })).toEqual({
			ok: true,
			mode: "plan",
		});
	});
});

describe("resolveEffectiveMode", () => {
	it("falls back to default with no flag and no stored mode", () => {
		expect(resolveEffectiveMode(undefined, new Map())).toBe("default");
	});

	it("uses a stored mode when no flag was given", () => {
		expect(resolveEffectiveMode(undefined, new Map([["project", "plan"]]))).toBe("plan");
	});

	it("the --permission-mode flag outranks a conflicting project rule", () => {
		expect(resolveEffectiveMode("bypassPermissions", new Map([["project", "plan"]]))).toBe("bypassPermissions");
	});

	it("respects source precedence among stored modes: local beats project beats user", () => {
		const modes = new Map([
			["user", "dontAsk"],
			["project", "acceptEdits"],
			["local", "plan"],
		] as const);
		expect(resolveEffectiveMode(undefined, modes)).toBe("plan");
	});
});
