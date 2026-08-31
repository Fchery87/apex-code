import { describe, expect, it } from "vitest";
import { HookConfigError, loadHookRuntime, parseHookSettings } from "../../src/core/hooks/loader.ts";
import type { HookEventName, HookHandler, HookHandlerConfig, HooksSettings } from "../../src/core/hooks/types.ts";

describe("parseHookSettings", () => {
	it("accepts a valid command and http handler", () => {
		const settings = parseHookSettings({
			tool_call: [{ type: "command", command: "echo '{}'", matcher: "bash|powershell" }],
			turn_end: [{ type: "http", url: "https://example.test/hook", timeoutMs: 1000 }],
		});

		expect(settings.tool_call).toHaveLength(1);
		expect(settings.turn_end).toEqual([{ type: "http", url: "https://example.test/hook", timeoutMs: 1000 }]);
	});

	it("accepts an empty object as the absent equivalent", () => {
		expect(parseHookSettings({})).toEqual({});
	});

	it("rejects a non-object config", () => {
		expect(() => parseHookSettings("hooks")).toThrow(HookConfigError);
		expect(() => parseHookSettings([])).toThrow(HookConfigError);
		expect(() => parseHookSettings(undefined)).toThrow(HookConfigError);
	});

	it("rejects unknown event names", () => {
		expect(() => parseHookSettings({ tool_start: [{ type: "command", command: "x" }] })).toThrow(/tool_start/);
	});

	it("rejects a handler without a known type", () => {
		expect(() => parseHookSettings({ tool_call: [{ command: "x" }] })).toThrow(/type/);
	});

	it("rejects unknown handler fields, so a mistyped key cannot silently drop policy", () => {
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "x", timeOutMs: 5 }] })).toThrow(
			/timeOutMs/,
		);
	});

	it("rejects a command handler without a command", () => {
		expect(() => parseHookSettings({ tool_call: [{ type: "command" }] })).toThrow(/command/);
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "" }] })).toThrow(/command/);
	});

	it("rejects an http handler without an http(s) url", () => {
		expect(() => parseHookSettings({ tool_call: [{ type: "http" }] })).toThrow(/url/);
		expect(() => parseHookSettings({ tool_call: [{ type: "http", url: "ftp://example.test" }] })).toThrow(/url/);
	});

	it("rejects a non-positive or non-numeric timeoutMs", () => {
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "x", timeoutMs: 0 }] })).toThrow(
			/timeoutMs/,
		);
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "x", timeoutMs: -5 }] })).toThrow(
			/timeoutMs/,
		);
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "x", timeoutMs: "10" }] })).toThrow(
			/timeoutMs/,
		);
	});

	it("rejects matchers with characters outside the exact-name grammar", () => {
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "x", matcher: "ba.*" }] })).toThrow(
			/matcher/,
		);
		expect(() => parseHookSettings({ tool_call: [{ type: "command", command: "x", matcher: "|" }] })).toThrow(
			/matcher/,
		);
	});

	it("rejects a config whose event value is not an array of handlers", () => {
		expect(() => parseHookSettings({ tool_call: { type: "command", command: "x" } })).toThrow(/tool_call/);
	});
});

describe("loadHookRuntime", () => {
	const commandConfig: HookHandlerConfig = { type: "command", command: "echo '{}'" };

	function handlersOf(
		runtime: NonNullable<ReturnType<typeof loadHookRuntime>>,
		event: HookEventName,
	): readonly HookHandler[] {
		return runtime.handlersFor(event);
	}

	it("returns undefined for absent or empty settings, so an absent key constructs nothing", () => {
		expect(loadHookRuntime(undefined)).toBeUndefined();
		expect(loadHookRuntime({})).toBeUndefined();
	});

	it("assembles handlers under their event", () => {
		const settings: HooksSettings = { tool_call: [commandConfig] };
		const created: HookHandlerConfig[] = [];
		const runtime = loadHookRuntime(settings, (config) => {
			created.push(config);
			return { execute: async () => ({ ok: true }) };
		});

		expect(runtime).toBeDefined();
		expect(runtime?.hasHandlers("tool_call")).toBe(true);
		expect(runtime?.hasHandlers("turn_end")).toBe(false);
		expect(created).toEqual([commandConfig]);
		expect(handlersOf(runtime!, "tool_call")).toHaveLength(1);
	});
});
