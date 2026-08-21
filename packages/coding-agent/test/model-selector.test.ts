import type { Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function render(selector: ModelSelectorComponent): string {
	return stripAnsi(selector.render(120).join("\n"));
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function createMultiProviderSelector(initialSearchInput?: string) {
		harness = await createHarness();
		const base = harness.getModel();
		const models = [
			{ ...base, provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
			{ ...base, provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
			{ ...base, provider: "openai", id: "gpt-5", name: "GPT-5" },
		] as unknown as Model<any>[];
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(models);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			initialSearchInput,
		);
		return selector;
	}

	it("lists every catalog that failed to refresh", async () => {
		harness = await createHarness();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel(),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			const rendered = render(selector);
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
	});

	it("opens on the provider step and shows each provider's model count", async () => {
		const selector = await createMultiProviderSelector();
		const rendered = render(selector);

		expect(rendered).toContain("Select a provider");
		expect(rendered).toContain("anthropic (2 models)");
		expect(rendered).toContain("openai (1 model)");
		expect(rendered).not.toContain("claude-opus-5");
	});

	it("drills into the chosen provider and lists only its models", async () => {
		const selector = await createMultiProviderSelector();
		selector.handleInput(ENTER);
		const rendered = render(selector);

		expect(rendered).toContain("anthropic › select a model");
		expect(rendered).toContain("claude-opus-5");
		expect(rendered).toContain("claude-sonnet-5");
		expect(rendered).not.toContain("gpt-5");
	});

	it("returns to the provider step on escape", async () => {
		const selector = await createMultiProviderSelector();
		selector.handleInput(ENTER);
		selector.handleInput(ESCAPE);
		const rendered = render(selector);

		expect(rendered).toContain("Select a provider");
		expect(rendered).toContain("anthropic (2 models)");
	});

	it("skips the provider step when opened with a search term", async () => {
		const selector = await createMultiProviderSelector("gpt");
		const rendered = render(selector);

		expect(rendered).toContain("All providers › select a model");
		expect(rendered).toContain("gpt-5");
		expect(rendered).toContain("[openai]");
		expect(rendered).not.toContain("claude-opus-5");
	});

	it("skips the provider step when only one provider is configured", async () => {
		harness = await createHarness();
		const base = harness.getModel();
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([
			{ ...base, provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
			{ ...base, provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
		] as unknown as Model<any>[]);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const rendered = render(selector);

		expect(rendered).not.toContain("Select a provider");
		expect(rendered).toContain("select a model");
	});

	it("selects a model with enter on the second step", async () => {
		harness = await createHarness();
		const base = harness.getModel();
		const models = [
			{ ...base, provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
			{ ...base, provider: "openai", id: "gpt-5", name: "GPT-5" },
		] as unknown as Model<any>[];
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(models);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);

		selector.handleInput(ENTER);
		selector.handleInput(ENTER);

		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect.mock.calls[0][0].id).toBe("claude-opus-5");
	});
});
