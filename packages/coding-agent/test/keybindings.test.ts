import { describe, expect, it } from "vitest";
import { KEYBINDINGS, KeybindingsManager, useWindowsKeybindings } from "../src/core/keybindings.ts";

describe("Windows keybinding defaults", () => {
	it("uses Windows keybindings on native Windows", () => {
		expect(useWindowsKeybindings("win32", {})).toBe(true);
	});

	it("uses Windows keybindings in WSL without relying on Windows Terminal detection", () => {
		expect(useWindowsKeybindings("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
		expect(useWindowsKeybindings("linux", { WSL_INTEROP: "/run/WSL/123_interop" })).toBe(true);
	});

	it("does not use Windows keybindings from WT_SESSION alone", () => {
		expect(useWindowsKeybindings("linux", { WT_SESSION: "session" })).toBe(false);
	});

	it("keeps non-Windows defaults on other platforms", () => {
		expect(useWindowsKeybindings("linux", {})).toBe(false);
		expect(useWindowsKeybindings("darwin", {})).toBe(false);
	});

	it("applies the detected defaults consistently", () => {
		const windowsKeybindings = useWindowsKeybindings();
		const nativeWindows = process.platform === "win32";

		expect(KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys).toBe(windowsKeybindings ? "alt+v" : "ctrl+v");
		expect(KEYBINDINGS["tui.altScreen.search"].defaultKeys).toBe(windowsKeybindings ? "ctrl+f" : "ctrl+shift+f");
		expect(KEYBINDINGS["app.message.followUp"].defaultKeys).toBe(windowsKeybindings ? "ctrl+q" : "alt+enter");
		expect(KEYBINDINGS["app.model.cycleBackward"].defaultKeys).toBe(windowsKeybindings ? "alt+p" : "shift+ctrl+p");
		expect(KEYBINDINGS["tui.editor.undo"].defaultKeys).toBe(
			nativeWindows ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
		);
		expect(KEYBINDINGS["tui.altScreen.previousPrompt"].defaultKeys).toEqual(
			windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
		);
		expect(KEYBINDINGS["tui.altScreen.nextPrompt"].defaultKeys).toEqual(
			windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
		);
		expect(KEYBINDINGS["app.message.dequeue"].defaultKeys).toBe(windowsKeybindings ? "alt+q" : "alt+up");
	});
});

describe("individual operation shortcut", () => {
	it("defaults to Alt+O and can be remapped independently of Ctrl+O", () => {
		expect(KEYBINDINGS["app.tools.expandLatest"].defaultKeys).toBe("alt+o");
		const keys = new KeybindingsManager({ "app.tools.expandLatest": "alt+u" });
		expect(keys.matches("\x1bu", "app.tools.expandLatest")).toBe(true);
		expect(keys.matches("\x1bo", "app.tools.expandLatest")).toBe(false);
		expect(keys.matches("\x0f", "app.tools.expand")).toBe(true);
	});
});
