import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type TreeNavigationResult, type TreeWorkspacePreview } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionCommandContextActions } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "./utilities.ts";

const busyMessage = "Wait for the current compaction or tree navigation to finish before navigating the session tree.";

function createTreeUI(preview: TreeWorkspacePreview = { state: "differs" }, realSession?: AgentSession) {
	const sessionManager = realSession?.sessionManager ?? SessionManager.inMemory();
	sessionManager.appendMessage(userMsg("first"));
	const targetId = sessionManager.appendMessage(assistantMsg("reply"));
	sessionManager.appendMessage(userMsg("later"));
	sessionManager.appendMessage(assistantMsg("later reply"));
	let selector: TreeSelectorComponent | undefined;
	const onEscape = vi.fn();
	const ui = {
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		session: {
			isStreaming: false,
			isCompacting: false,
			abort: vi.fn(async () => {
				ui.session.isStreaming = false;
			}),
			abortBranchSummary: vi.fn(),
			previewTreeWorkspace: vi.fn(async () => preview),
			navigateTree: vi.fn<() => Promise<TreeNavigationResult>>(async () => {
				if (ui.session.isCompacting) throw new Error(busyMessage);
				return { cancelled: false, workspace: { policy: "keep", outcome: "unchanged", warnings: [] } };
			}),
		},
		defaultEditor: { onEscape },
		editor: { getText: () => "", setText: vi.fn() },
		chatContainer: new Container(),
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: { terminal: { rows: 24, setProgress: vi.fn() }, requestRender: vi.fn() },
		showSelector: (
			create: (done: () => void) => { component: TreeSelectorComponent; focus: TreeSelectorComponent },
		) => {
			selector = create(vi.fn()).component;
		},
		showExtensionSelector: vi.fn<(title: string, options: string[]) => Promise<string | undefined>>(async (title) =>
			title === "Summarize branch?" ? "No summary" : "Keep current files",
		),
		showStatusIndicator: vi.fn((indicator: StatusIndicator) => indicator.dispose()),
		clearStatusIndicator: vi.fn(),
		restoreQueuedMessagesToEditor: vi.fn(),
		renderInitialMessages: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
	};
	if (realSession) Reflect.set(ui, "session", realSession);
	const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof ui) => void;
	showTreeSelector.call(ui);

	return {
		ui,
		onEscape,
		targetId,
		async select() {
			expect(selector).toBeDefined();
			await selector!.getTreeList().onSelect!(targetId);
		},
	};
}

describe("tree workspace prompt", () => {
	beforeEach(() => initTheme("dark"));

	it.each([
		{ state: "no-checkpoint" },
		{ state: "matches" },
		{ state: "unavailable", reason: "Git unavailable" },
	] as const)("does not ask on $state", async (preview) => {
		const { ui, targetId, select } = createTreeUI(preview);
		await select();
		expect(ui.showExtensionSelector).toHaveBeenCalledTimes(1);
		expect(ui.session.navigateTree).toHaveBeenCalledWith(targetId, {
			summarize: false,
			customInstructions: undefined,
			workspacePolicy: "keep",
		});
		expect(ui.showStatus).toHaveBeenCalledWith(
			preview.state === "no-checkpoint" ? "Files unchanged · no checkpoint for this point" : "Files unchanged",
		);
	});

	it.each([
		["Keep current files", "keep"],
		["Restore files to this point", "restore"],
	] as const)("maps %s to %s", async (choice, policy) => {
		const { ui, targetId, select } = createTreeUI();
		ui.showExtensionSelector.mockResolvedValueOnce("No summary").mockResolvedValueOnce(choice);
		await select();
		expect(ui.showExtensionSelector).toHaveBeenLastCalledWith("Restore workspace files?", [
			"Keep current files",
			"Restore files to this point",
			"Cancel",
		]);
		expect(ui.session.navigateTree).toHaveBeenCalledWith(targetId, {
			summarize: false,
			customInstructions: undefined,
			workspacePolicy: policy,
		});
	});

	it.each(["Cancel", undefined])("does not navigate when the workspace choice is %s", async (choice) => {
		const { ui, select } = createTreeUI();
		ui.showExtensionSelector.mockResolvedValueOnce("No summary").mockResolvedValueOnce(choice);
		const leaf = ui.sessionManager.getLeafId();
		await select();
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
		expect(ui.sessionManager.getLeafId()).toBe(leaf);
		expect(ui.showStatus).toHaveBeenCalledWith("Navigation cancelled");
	});

	it("keeps summary and workspace choices separate", async () => {
		const { ui, targetId, select } = createTreeUI();
		ui.showExtensionSelector.mockResolvedValueOnce("Summarize").mockResolvedValueOnce("Restore files to this point");
		await select();
		expect(ui.session.navigateTree).toHaveBeenCalledWith(targetId, {
			summarize: true,
			customInstructions: undefined,
			workspacePolicy: "restore",
		});
	});

	it("preserves operation UI when compaction starts during a differing preview", async () => {
		const { ui, onEscape, select } = createTreeUI();
		vi.mocked(ui.session.previewTreeWorkspace).mockImplementation(async () => {
			ui.session.isCompacting = true;
			return { state: "differs" };
		});
		await select();
		expect(ui.showExtensionSelector).toHaveBeenCalledTimes(1);
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
	});

	it.each(["preview", "dialog"])("rechecks compaction after the %s", async (during) => {
		const { ui, select } = createTreeUI();
		if (during === "preview")
			vi.mocked(ui.session.previewTreeWorkspace).mockImplementation(async () => {
				ui.session.isCompacting = true;
				return { state: "matches" };
			});
		else
			ui.showExtensionSelector.mockImplementation(async (title) => {
				if (title !== "Summarize branch?") ui.session.isCompacting = true;
				return title === "Summarize branch?" ? "No summary" : "Restore files to this point";
			});
		await select();
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
	});

	it.each([
		[
			{
				policy: "restore",
				outcome: "restored",
				preRestoreCheckpoint: { entryId: "pre-restore", commit: "abc" },
				warnings: [],
			},
			"Restored files · pre-restore checkpoint saved",
		],
		[
			{ policy: "restore", outcome: "missing-checkpoint", warnings: [] },
			"Files unchanged · no checkpoint for this point",
		],
		[
			{ policy: "restore", outcome: "failed", warnings: ["restore failed; workspace left unchanged"] },
			"restore failed; workspace left unchanged",
		],
	] as const)("reports workspace outcome $0.outcome", async (workspace, status) => {
		const { ui, select } = createTreeUI();
		vi.mocked(ui.session.navigateTree).mockResolvedValue({
			cancelled: false,
			workspace: { ...workspace, warnings: [...workspace.warnings] },
		});
		await select();
		expect(ui.showStatus).toHaveBeenCalledExactlyOnceWith(status);
	});

	it("passes extension workspace policy through the interactive adapter", async () => {
		let actions: ExtensionCommandContextActions | undefined;
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const ui = {
			createExtensionUIContext: () => ({}),
			session: {
				bindExtensions: async (options: { commandContextActions: ExtensionCommandContextActions }) => {
					actions = options.commandContextActions;
				},
				navigateTree,
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
			},
			chatContainer: new Container(),
			editor: { getText: () => "", setText: vi.fn() },
			renderInitialMessages: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn(),
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			showLoadedResources: vi.fn(),
			showStartupNoticesIfNeeded: vi.fn(),
		};
		await Reflect.get(InteractiveMode.prototype, "bindCurrentSessionExtensions").call(ui);
		await actions!.navigateTree("target", { workspacePolicy: "restore", summarize: true });
		expect(navigateTree).toHaveBeenCalledWith("target", {
			summarize: true,
			customInstructions: undefined,
			replaceInstructions: undefined,
			label: undefined,
			workspacePolicy: "restore",
		});
	});
});

describe("tree workspace prompt with a real Git checkpoint", () => {
	let cwd: string;
	let tempDir: string;
	let session: AgentSession;
	beforeEach(() => {
		initTheme("dark");
		cwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "apex-tree-prompt-"));
		process.chdir(tempDir);
		for (const args of [
			["init", "-b", "main"],
			["config", "user.email", "test@example.com"],
			["config", "user.name", "test"],
		])
			execFileSync("git", args, { cwd: tempDir });
		writeFileSync(join(tempDir, "tracked.txt"), "before\n");
		execFileSync("git", ["add", "-A"], { cwd: tempDir });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
	});
	afterEach(() => {
		session?.dispose();
		process.chdir(cwd);
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	it.each(["Keep current files", "Restore files to this point", "Cancel"])(
		"%s preserves the selected policy",
		async (choice) => {
			const registry = await createModelRegistry(AuthStorage.inMemory());
			session = new AgentSession({
				agent: new Agent({ streamFn: streamSimple }),
				sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
				settingsManager: SettingsManager.inMemory(),
				cwd: tempDir,
				modelRuntime: getModelRuntime(registry),
				resourceLoader: createTestResourceLoader(),
			});
			const { ui, targetId, select } = createTreeUI({ state: "differs" }, session);
			expect(await session.checkpoints.capture(targetId)).toBeDefined();
			writeFileSync(join(tempDir, "tracked.txt"), "after\n");
			writeFileSync(join(tempDir, "extra.txt"), "external edit\n");
			const oldLeaf = session.sessionManager.getLeafId();
			ui.showExtensionSelector.mockResolvedValueOnce("No summary").mockResolvedValueOnce(choice);
			await select();
			expect(ui.showExtensionSelector).toHaveBeenCalledTimes(2);
			expect(session.sessionManager.getLeafId()).toBe(choice === "Cancel" ? oldLeaf : targetId);
			expect(readFileSync(join(tempDir, "tracked.txt"), "utf-8")).toBe(
				choice === "Restore files to this point" ? "before\n" : "after\n",
			);
			expect(existsSync(join(tempDir, "extra.txt"))).toBe(choice !== "Restore files to this point");
			if (choice !== "Restore files to this point")
				expect(readFileSync(join(tempDir, "extra.txt"), "utf-8")).toBe("external edit\n");
			expect(ui.showStatus).toHaveBeenCalledExactlyOnceWith(
				choice === "Restore files to this point"
					? "Restored files · pre-restore checkpoint saved"
					: choice === "Cancel"
						? "Navigation cancelled"
						: "Files unchanged",
			);
		},
	);
});
