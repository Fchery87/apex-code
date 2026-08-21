import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import {
	resolveEffectiveMode,
	resolveEffectiveModeWithOrigin,
	resolvePermissionModeForStartup,
} from "../../src/core/permissions/startup.ts";

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

/**
 * The settings UI writes to `user` scope and has to be able to say "saved, but
 * something else is in force". That is only possible if resolution reports which
 * source won, so these pin the origin rather than just the mode.
 */
describe("resolveEffectiveModeWithOrigin", () => {
	it("reports the default origin when nothing set a mode", () => {
		expect(resolveEffectiveModeWithOrigin(undefined, new Map())).toEqual({ mode: "default", origin: "default" });
	});

	it("reports user as the origin for a mode a settings write persisted", () => {
		expect(resolveEffectiveModeWithOrigin(undefined, new Map([["user", "bypassPermissions"]]))).toEqual({
			mode: "bypassPermissions",
			origin: "user",
		});
	});

	it("reports the flag as the origin when it shadows a user-scope write", () => {
		expect(resolveEffectiveModeWithOrigin("plan", new Map([["user", "bypassPermissions"]]))).toEqual({
			mode: "plan",
			origin: "flag",
		});
	});

	it.each(["local", "project"] as const)("reports %s as the origin when it shadows a user-scope write", (source) => {
		expect(
			resolveEffectiveModeWithOrigin(
				undefined,
				new Map([
					[source, "plan"],
					["user", "bypassPermissions"],
				]),
			),
		).toEqual({
			mode: "plan",
			origin: source,
		});
	});

	it("agrees with resolveEffectiveMode across every source", () => {
		const cases: Parameters<typeof resolveEffectiveModeWithOrigin>[] = [
			[undefined, new Map()],
			[undefined, new Map([["session", "plan"]])],
			[
				undefined,
				new Map([
					["command", "dontAsk"],
					["session", "plan"],
				]),
			],
			[
				undefined,
				new Map([
					["user", "acceptEdits"],
					["command", "dontAsk"],
				]),
			],
			["bypassPermissions", new Map([["local", "plan"]])],
		];
		for (const [flagMode, modes] of cases) {
			expect(resolveEffectiveModeWithOrigin(flagMode, modes).mode).toBe(resolveEffectiveMode(flagMode, modes));
		}
	});
});
