import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("titles the panel and speaks the shared hint grammar", () => {
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				availableDefaultModels: [],
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{} as unknown as SettingsCallbacks,
		);
		const lines = selector.render(100).map((line) => stripAnsi(line).trimEnd());

		expect(lines).toContain("Settings");
		expect(lines).toContain("enter/space change · escape/ctrl+c close");
		expect(lines.join("\n")).not.toMatch(/Type to search|Esc to cancel/);
	});

	function openPermissionMode(onPermissionModeChange: SettingsCallbacks["onPermissionModeChange"]) {
		const selector = new SettingsSelectorComponent(
			{
				permissionMode: { mode: "default", origin: "user" },
				fullscreenScrollbar: "auto",
				warnings: {},
				availableDefaultModels: [],
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ onPermissionModeChange } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();
		for (const character of "Permission mode") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		return settingsList;
	}

	const DOWN = "\x1b[B";

	it("omits the permission mode row when the session has no permission gate", () => {
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				availableDefaultModels: [],
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{} as unknown as SettingsCallbacks,
		);
		expect(selector.getSettingsList().render(80).join("\n")).not.toContain("Permission mode");
	});

	it("applies a non-bypass mode without a confirm step", () => {
		const onChange = vi.fn();
		const settingsList = openPermissionMode(onChange);

		settingsList.handleInput(DOWN);
		settingsList.handleInput("\r");

		expect(onChange.mock.calls.flat()).toEqual(["plan"]);
	});

	it("does not apply bypassPermissions until the confirm step is accepted", () => {
		const onChange = vi.fn();
		const settingsList = openPermissionMode(onChange);

		for (let i = 0; i < 3; i++) settingsList.handleInput(DOWN);
		settingsList.handleInput("\r");
		expect(onChange).not.toHaveBeenCalled();

		settingsList.handleInput(DOWN);
		settingsList.handleInput("\r");
		expect(onChange.mock.calls.flat()).toEqual(["bypassPermissions"]);
	});

	it("declining the confirm leaves the mode unchanged", () => {
		const onChange = vi.fn();
		const settingsList = openPermissionMode(onChange);

		for (let i = 0; i < 3; i++) settingsList.handleInput(DOWN);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("    Automatic");
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			defaultModel: "not set",
			availableDefaultModels: [],
			modelThinkingLevels: {},
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model")!;
		const modelKey = `${model.provider}/${model.id}`;
		const config = {
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
	});
});
