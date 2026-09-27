import type { Model } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { selectedRowId, selectorRowIds } from "./suite/selector-rows.ts";
import { accentOpen, paintedWidth, selectedRowOpen } from "./suite/theme-ansi.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";

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

	beforeEach(() => {
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
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			initialSearchInput,
		);
		return selector;
	}

	// Upstream's version of this test pins pi's `→ ✓ id [provider]` row. Apex rows
	// carry `current` in the trailing cluster instead, so the same behaviour is
	// asserted against that shape.
	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			render(selector)
				.split("\n")
				.find((line) => selectorRowIds(line)[0] === id)
				?.trimEnd();

		expect(selectedRowId(render(selector))).toBe("current-model");
		expect(getModelRow("current-model")).toMatch(/current-model · current$/);
		selector.handleInput(DOWN);
		expect(selectedRowId(render(selector))).toBe("browsed-model");
		expect(getModelRow("current-model")).toMatch(/current-model · current$/);
		expect(getModelRow("browsed-model")).toMatch(/browsed-model$/);
		selector.dispose();
	});

	it("uses the configured save binding", async () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(render(selector)).toContain("ctrl+r set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel, undefined);
	});

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

	it("lights the selected row with a background step, not with accent text", async () => {
		const selector = await createMultiProviderSelector();
		const selected = selector.render(120).find((line) => stripAnsi(line).trimStart().startsWith("→ "));

		expect(selected).toBeDefined();
		expect(selected).toContain(selectedRowOpen());
		expect(selected).not.toContain(accentOpen());
	});

	it("keeps the selected row's fill hugging its text", async () => {
		const selector = await createMultiProviderSelector();
		const selected = selector.render(120).find((line) => stripAnsi(line).trimStart().startsWith("→ "));

		// SelectListTheme.selectedText is handed a composed row and no width, so a
		// full-width fill is unreachable without patching pi-tui. Matching the frozen
		// component beats diverging from it.
		expect(paintedWidth(selected ?? "")).toBeGreaterThan(0);
		expect(paintedWidth(selected ?? "")).toBeLessThan(120);
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
		expect(selectorRowIds(rendered)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
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
		expect(rendered).toContain("openai · gpt-5");
		expect(selectorRowIds(rendered)).toEqual(["gpt-5"]);
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
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);
		const rendered = render(selector);

		expect(rendered).not.toContain("Select a provider");
		expect(rendered).toContain("select a model");
	});

	async function createReasoningSelector(onSelect = vi.fn()) {
		harness = await createHarness();
		const base = harness.getModel();
		const models = [
			{ ...base, provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
			{ ...base, provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
		] as unknown as Model<any>[];
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(models);
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);
		return { selector, onSelect };
	}

	it("names the model on the row and keeps its id in the trailing context", async () => {
		const selector = await createMultiProviderSelector();
		selector.handleInput(ENTER);
		const rendered = render(selector);

		expect(rendered).toContain("Claude Opus 5");
		expect(rendered).toContain("claude-opus-5");
		expect(selectorRowIds(rendered)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
	});

	it("carries the selected model row's fill to the right edge", async () => {
		const selector = await createMultiProviderSelector();
		selector.handleInput(ENTER);
		const selected = selector.render(120).find((line) => stripAnsi(line).startsWith("→ "));

		// Unlike a provider row, a model row right-aligns its trailing context, so
		// a fill that stopped at the last glyph would change shape row to row.
		expect(paintedWidth(selected ?? "")).toBe(120);
	});

	it("prices the highlighted model instead of repeating its name", async () => {
		const selector = await createMultiProviderSelector();
		selector.handleInput(ENTER);
		const rendered = render(selector);

		expect(rendered).toContain("$ / 1M tokens");
		expect(rendered).toContain("Cached input");
		expect(rendered).not.toContain("Model Name:");
	});

	it("dials the highlighted model's effort with left and right", async () => {
		const { selector } = await createReasoningSelector();
		expect(render(selector)).toContain("off");

		selector.handleInput(RIGHT);
		expect(render(selector)).toContain("minimal");

		selector.handleInput(LEFT);
		expect(render(selector)).toContain("off");
	});

	it("hands back the dialled effort, and nothing when it was left alone", async () => {
		const dialled = await createReasoningSelector();
		dialled.selector.handleInput(RIGHT);
		dialled.selector.handleInput(RIGHT);
		dialled.selector.handleInput(ENTER);
		expect(dialled.onSelect.mock.calls[0][1]).toBe("low");

		harness?.cleanup();
		harness = undefined;

		const untouched = await createReasoningSelector();
		untouched.selector.handleInput(ENTER);
		expect(untouched.onSelect.mock.calls[0][1]).toBeUndefined();
	});

	it("leaves left and right to the search cursor until the list is entered", async () => {
		const { selector } = await createReasoningSelector();
		selector.handleInput("o");
		selector.handleInput(RIGHT);
		expect(render(selector)).toContain("off");

		selector.handleInput(DOWN);
		selector.handleInput(RIGHT);
		expect(render(selector)).toContain("minimal");
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
