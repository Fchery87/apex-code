import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
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

	it("cycles the remembered conversation detail level", () => {
		const onChatDetailChange = vi.fn();
		const config = {
			chatDetail: "overview",
			warnings: {},
			availableDefaultModels: [],
			availableThinkingLevels: [],
			availableThemes: [],
		} as unknown as SettingsConfig;
		const list = new SettingsSelectorComponent(config, {
			onChatDetailChange,
		} as unknown as SettingsCallbacks).getSettingsList();
		for (const character of "Conversation detail") list.handleInput(character);
		for (let i = 0; i < 3; i++) list.handleInput("\r");

		expect(onChatDetailChange.mock.calls.flat()).toEqual(["details", "all", "overview"]);
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
});
