import { Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppKeybinding, KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import type { EffectiveModeResolution } from "../src/core/permissions/startup.ts";
import type { PermissionMode } from "../src/core/permissions/store.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fixture(initial: PermissionMode = "default", bypass = false, seen: string[] = []) {
	let resolution: EffectiveModeResolution = { mode: initial, origin: "flag" };
	const settingsManager = {
		getFirstUseHints: () => seen,
		setFirstUseHints: vi.fn((hints: string[]) => {
			seen = hints;
		}),
	};
	const session = {
		settingsManager,
		getPermissionMode: vi.fn(async () => resolution),
		getInteractivePermissionModeCycle: vi.fn(
			async (): Promise<readonly PermissionMode[]> => [
				"default",
				"acceptEdits",
				"plan",
				...(bypass ? ["bypassPermissions" as const] : []),
			],
		),
		setInteractivePermissionMode: vi.fn(async (mode: PermissionMode) => {
			resolution = { mode, origin: "interactive" };
			return resolution;
		}),
		setPermissionMode: vi.fn(async (_mode: PermissionMode) => resolution),
	};
	const actions = new Map<AppKeybinding, () => unknown>();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session },
		defaultEditor: { onAction: (action: AppKeybinding, handler: () => unknown) => actions.set(action, handler) },
		footer: { setPermissionMode: vi.fn() },
		chatContainer: new Container(),
		outputPad: 0,
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
	});
	Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
	return {
		mode,
		session,
		settingsManager,
		actions,
		getResolution: () => resolution,
		cycle: async () => {
			const action = actions.get("app.permissionMode.cycle");
			expect(action).toBeDefined();
			await action!();
		},
		output: () => stripAnsi(mode.chatContainer.render(160).join("\n")),
	};
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(new KeybindingsManager()));

describe("permission mode keybinding", () => {
	it("assigns separate default bindings to permission and thinking cycles", () => {
		expect(KEYBINDINGS["app.permissionMode.cycle"].defaultKeys).toBe("shift+tab");
		expect(KEYBINDINGS["app.thinking.cycle"].defaultKeys).toBe("alt+t");
		const keys = new KeybindingsManager();
		expect(keys.getKeys("app.permissionMode.cycle")).toEqual(["shift+tab"]);
		expect(keys.getKeys("app.thinking.cycle")).not.toContain("shift+tab");
		const actionsUsing = (key: string) =>
			Object.entries(KEYBINDINGS)
				.filter(([, definition]) => {
					const keys: readonly string[] = Array.isArray(definition.defaultKeys)
						? definition.defaultKeys
						: [definition.defaultKeys];
					return keys.includes(key);
				})
				.map(([action]) => action);
		expect(actionsUsing("shift+tab")).toEqual(["app.permissionMode.cycle"]);
		expect(actionsUsing("alt+t")).toEqual(["app.thinking.cycle"]);
	});

	it("cycles session modes through the registered editor action", async () => {
		const ui = fixture();
		for (const next of ["acceptEdits", "plan", "default"]) {
			await ui.cycle();
			expect(ui.getResolution()).toEqual({ mode: next, origin: "interactive" });
		}
		expect(ui.session.setPermissionMode).not.toHaveBeenCalled();
		expect(ui.mode.footer.setPermissionMode).toHaveBeenLastCalledWith("default", "interactive");
	});

	it("includes startup-authorized bypass before default", async () => {
		const ui = fixture("plan", true);
		await ui.cycle();
		expect(ui.getResolution().mode).toBe("bypassPermissions");
		await ui.cycle();
		expect(ui.getResolution().mode).toBe("default");
	});

	it("enters the documented cycle from dontAsk", async () => {
		const ui = fixture("dontAsk");
		await ui.cycle();
		expect(ui.getResolution().mode).toBe("default");
	});

	it("does nothing without a permission gate", async () => {
		const ui = fixture();
		ui.session.getInteractivePermissionModeCycle.mockResolvedValue([]);
		await ui.cycle();
		expect(ui.session.setInteractivePermissionMode).not.toHaveBeenCalled();
		expect(ui.settingsManager.setFirstUseHints).not.toHaveBeenCalled();
		expect(ui.mode.footer.setPermissionMode).not.toHaveBeenCalled();
	});

	it("serializes rapid presses into distinct transitions", async () => {
		const ui = fixture();
		await Promise.all([ui.cycle(), ui.cycle(), ui.cycle()]);
		expect(ui.session.setInteractivePermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
			"acceptEdits",
			"plan",
			"default",
		]);
	});

	it("uses live keybindings in the migration hint and remembers it once", async () => {
		setKeybindings(new KeybindingsManager({ "app.permissionMode.cycle": "ctrl+x", "app.thinking.cycle": "ctrl+y" }));
		const ui = fixture();
		await ui.cycle();
		await ui.cycle();
		expect(ui.output()).toContain("Ctrl+X");
		expect(ui.output()).toContain("Ctrl+Y");
		expect(ui.output()).not.toContain("Shift+Tab");
		expect(ui.settingsManager.setFirstUseHints).toHaveBeenCalledTimes(1);
		const resumed = fixture("default", false, ui.settingsManager.setFirstUseHints.mock.calls[0][0]);
		await resumed.cycle();
		expect(resumed.output()).toBe("");
		expect(resumed.settingsManager.setFirstUseHints).not.toHaveBeenCalled();
	});

	it("does not remember the hint after a failed change", async () => {
		const ui = fixture();
		ui.session.setInteractivePermissionMode.mockRejectedValue(new Error("cannot change"));
		await ui.cycle();
		expect(ui.settingsManager.setFirstUseHints).not.toHaveBeenCalled();
		expect(ui.mode.showError).toHaveBeenCalled();
	});

	it("drops an old session's pending and queued cycles after replacement", async () => {
		const ui = fixture();
		expect(ui.actions.get("app.permissionMode.cycle")).toBeDefined();
		let resolve!: (modes: readonly PermissionMode[]) => void;
		ui.session.getInteractivePermissionModeCycle.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const first = ui.cycle();
		const second = ui.cycle();
		await vi.waitFor(() => expect(ui.session.getInteractivePermissionModeCycle).toHaveBeenCalled());
		const replacement = fixture().session;
		ui.mode.runtimeHost.session = replacement;
		resolve(["default", "acceptEdits", "plan"]);
		await Promise.all([first, second]);
		expect(ui.session.setInteractivePermissionMode).not.toHaveBeenCalled();
		expect(replacement.setInteractivePermissionMode).not.toHaveBeenCalled();
		expect(ui.mode.footer.setPermissionMode).not.toHaveBeenCalled();
		expect(ui.settingsManager.setFirstUseHints).not.toHaveBeenCalled();
	});

	it("does not repaint a replacement after an old setter settles", async () => {
		const ui = fixture();
		expect(ui.actions.get("app.permissionMode.cycle")).toBeDefined();
		let resolve!: (resolution: EffectiveModeResolution) => void;
		ui.session.setInteractivePermissionMode.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const pending = ui.cycle();
		await vi.waitFor(() => expect(ui.session.setInteractivePermissionMode).toHaveBeenCalled());
		ui.mode.runtimeHost.session = fixture().session;
		resolve({ mode: "acceptEdits", origin: "interactive" });
		await pending;
		expect(ui.mode.footer.setPermissionMode).not.toHaveBeenCalled();
		expect(ui.settingsManager.setFirstUseHints).not.toHaveBeenCalled();
	});

	it("lets a replacement session cycle before an old pending read resolves", async () => {
		const ui = fixture();
		let resolve!: (modes: readonly PermissionMode[]) => void;
		ui.session.getInteractivePermissionModeCycle.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const oldCycle = ui.cycle();
		await vi.waitFor(() => expect(ui.session.getInteractivePermissionModeCycle).toHaveBeenCalled());
		const replacement = fixture();
		ui.mode.runtimeHost.session = replacement.session;
		Object.assign(ui.mode, {
			applyRuntimeSettings: vi.fn(),
			bindCurrentSessionExtensions: vi.fn(async () => {}),
			subscribeToAgent: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
		});
		await Reflect.get(InteractiveMode.prototype, "rebindCurrentSession").call(ui.mode);
		const newCycle = ui.cycle();
		try {
			await vi.waitFor(() =>
				expect(replacement.session.setInteractivePermissionMode).toHaveBeenCalledWith("acceptEdits"),
			);
		} finally {
			resolve(["default", "acceptEdits", "plan"]);
			await Promise.all([oldCycle, newCycle]);
		}
		expect(ui.session.setInteractivePermissionMode).not.toHaveBeenCalled();
	});

	it("refreshes the footer after reload clears the override and fails", async () => {
		const ui = fixture("bypassPermissions", true);
		await ui.cycle();
		Object.assign(ui.session, {
			reload: vi.fn(async () => {
				ui.session.getPermissionMode.mockResolvedValue({ mode: "bypassPermissions", origin: "flag" });
				throw new Error("resources unavailable");
			}),
		});
		Object.assign(ui.mode, {
			editor: { render: () => [] },
			editorContainer: new Container(),
			resetExtensionUI: vi.fn(),
		});
		ui.mode.ui.setFocus = vi.fn();
		await Reflect.get(InteractiveMode.prototype, "handleReloadCommand").call(ui.mode);
		expect(ui.mode.showError).toHaveBeenCalledWith("Reload failed: resources unavailable");
		expect(ui.mode.footer.setPermissionMode).toHaveBeenLastCalledWith("bypassPermissions", "flag");
	});

	it.each(["cycle", "resolution"] as const)(
		"drops pending and queued cycles when /reload interrupts the %s read",
		async (read) => {
			const ui = fixture();
			let resolve!: () => void;
			const wait = new Promise<void>((done) => {
				resolve = done;
			});
			if (read === "cycle")
				ui.session.getInteractivePermissionModeCycle.mockImplementation(async () => {
					await wait;
					return ["default", "acceptEdits", "plan"];
				});
			else
				ui.session.getPermissionMode.mockImplementation(async () => {
					await wait;
					return { mode: "default", origin: "flag" };
				});
			Object.assign(ui.settingsManager, {
				getHideThinkingBlock: () => false,
				getChatDetail: () => "details",
				getOutputPad: () => 0,
			});
			Object.assign(ui.session, {
				reload: vi.fn(async () => {}),
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
				modelRuntime: { getError: () => undefined },
			});
			Object.assign(ui.mode, {
				editor: { render: () => [] },
				editorContainer: new Container(),
				resetExtensionUI: vi.fn(),
				loadChatDetail: vi.fn(),
				rebuildChatFromMessages: vi.fn(),
				keybindings: { reload: vi.fn() },
				applyRuntimeSettings: vi.fn(),
				themeController: { applyFromSettings: vi.fn(async () => {}) },
				setupAutocompleteProvider: vi.fn(),
				setupExtensionShortcuts: vi.fn(),
				showLoadedResources: vi.fn(),
				maybeSaveImplicitProjectTrustAfterReload: () => false,
				showStatus: vi.fn(),
			});
			ui.mode.ui.setFocus = vi.fn();
			const first = ui.cycle();
			const second = ui.cycle();
			await vi.waitFor(() =>
				expect(
					read === "cycle" ? ui.session.getInteractivePermissionModeCycle : ui.session.getPermissionMode,
				).toHaveBeenCalled(),
			);
			await Reflect.get(InteractiveMode.prototype, "handleReloadCommand").call(ui.mode);
			expect(ui.mode.showStatus).toHaveBeenCalled();
			resolve();
			await Promise.all([first, second]);
			expect(ui.session.setInteractivePermissionMode).not.toHaveBeenCalled();
			expect(ui.mode.footer.setPermissionMode).not.toHaveBeenCalled();
			expect(ui.settingsManager.setFirstUseHints).not.toHaveBeenCalled();
		},
	);

	it("reports /settings shadowing even when the saved mode equals the session mode", async () => {
		const ui = fixture();
		await ui.cycle();
		Reflect.set(ui.mode, "chatContainer", new Container());
		await Reflect.get(InteractiveMode.prototype, "applyPermissionMode").call(ui.mode, "acceptEdits");
		expect(ui.session.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
		expect(ui.output()).toContain("saved as acceptEdits");
		expect(ui.output()).toContain("for this session");
		expect(ui.mode.footer.setPermissionMode).toHaveBeenLastCalledWith("acceptEdits", "interactive");
	});
});
