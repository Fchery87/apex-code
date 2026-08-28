import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

interface DefaultModelReference {
	provider: string;
	id: string;
}

type ModelScope = "all" | "scoped";

/**
 * Which of the two steps the selector is on. `provider: null` lists every provider's models at once,
 * which is how a `/model <search>` invocation and a single-provider setup both open.
 */
type Step = { kind: "providers" } | { kind: "models"; provider: string | null };

type Row =
	| { kind: "provider"; provider: string; count: number; hasCurrent: boolean }
	| { kind: "model"; item: ModelItem };

const MAX_VISIBLE_ROWS = 10;

/**
 * Component that renders a two-step model selector: provider first, then that provider's models.
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private headerContainer: Container;
	private listContainer: Container;
	private footerContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private rows: Row[] = [];
	private filteredRows: Row[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	private scope: ModelScope = "all";
	private step: Step = { kind: "providers" };
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.headerContainer = new Container();
		this.addChild(this.headerContainer);
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => this.confirmSelection();
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Keybindings live under the list, where the eye already is once it has
		// finished reading. Above the list they were the first thing read and the
		// least useful.
		this.footerContainer = new Container();
		this.addChild(this.footerContainer);

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		this.step = this.initialStep(initialSearchInput);
		this.rebuildRows();
		this.selectedIndex = this.defaultSelectedIndex();
		this.renderHeader();
		this.filterRows(this.searchInput.getValue());
		this.tui.requestRender();
		void this.refreshModels();
	}

	private initialStep(initialSearchInput: string | undefined): Step {
		const providers = this.activeProviders();
		if (initialSearchInput) return { kind: "models", provider: null };
		if (providers.length <= 1) return { kind: "models", provider: providers[0] ?? null };
		return { kind: "providers" };
	}

	private activeProviders(): string[] {
		return [...new Set(this.activeModels.map((item) => item.provider))];
	}

	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.rebuildRows();
			this.renderHeader();
			this.filterRows(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, default model second, then by provider.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private rebuildRows(): void {
		if (this.step.kind === "providers") {
			const byProvider = new Map<string, ModelItem[]>();
			for (const item of this.activeModels) {
				const existing = byProvider.get(item.provider);
				if (existing) existing.push(item);
				else byProvider.set(item.provider, [item]);
			}
			const providerRows: Row[] = [...byProvider].map(([provider, items]) => ({
				kind: "provider",
				provider,
				count: items.length,
				hasCurrent: items.some((item) => modelsAreEqual(this.currentModel, item.model)),
			}));
			providerRows.sort((a, b) => {
				if (a.kind !== "provider" || b.kind !== "provider") return 0;
				if (a.hasCurrent !== b.hasCurrent) return a.hasCurrent ? -1 : 1;
				return a.provider.localeCompare(b.provider);
			});
			this.rows = providerRows;
			return;
		}
		const provider = this.step.provider;
		const models = provider === null ? this.activeModels : this.activeModels.filter((m) => m.provider === provider);
		this.rows = models.map((item) => ({ kind: "model", item }));
	}

	private defaultSelectedIndex(): number {
		const index = this.rows.findIndex((row) =>
			row.kind === "provider" ? row.hasCurrent : modelsAreEqual(this.currentModel, row.item.model),
		);
		return index >= 0 ? index : 0;
	}

	private setStep(step: Step): void {
		this.step = step;
		this.searchInput.setValue("");
		this.rebuildRows();
		this.selectedIndex = this.defaultSelectedIndex();
		this.renderHeader();
		this.filterRows("");
		this.tui.requestRender();
	}

	private isDrilledIn(): boolean {
		return this.step.kind === "models" && this.step.provider !== null;
	}

	/** Escape returns to the provider list whenever there is a provider list worth returning to. */
	private canGoBack(): boolean {
		return this.step.kind === "models" && this.activeProviders().length > 1;
	}

	private renderHeader(): void {
		this.headerContainer.clear();

		if (this.step.kind === "providers") {
			this.headerContainer.addChild(new Text(theme.bold(theme.fg("accent", "Select a provider")), 0, 0));
		} else {
			const label = this.step.provider ?? "All providers";
			const crumb = `${theme.bold(theme.fg("accent", label))}${theme.fg("muted", " › select a model")}`;
			this.headerContainer.addChild(new Text(crumb, 0, 0));
		}

		if (this.scopedModelItems.length > 0) {
			this.headerContainer.addChild(new Text(this.getScopeText(), 0, 0));
		} else if (!this.isDrilledIn()) {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.headerContainer.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}

		this.renderFooter();
	}

	private renderFooter(): void {
		this.footerContainer.clear();
		this.footerContainer.addChild(new Text(this.getHintText(), 0, 0));
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getHintText(): string {
		const hints: string[] = [
			// Both arrows, since either one moves the selection.
			rawKeyHint(`${keyText("tui.select.up")}/${keyText("tui.select.down")}`, "move"),
			keyHint("tui.select.confirm", "select"),
		];
		if (this.scopedModelItems.length > 0) {
			hints.push(keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)"));
		}
		if (this.onSelectAsDefaultCallback) hints.push(rawKeyHint("ctrl+s", "set as default"));
		if (this.canGoBack()) hints.push(rawKeyHint("escape", "providers"), rawKeyHint("ctrl+c", "close"));
		else hints.push(keyHint("tui.select.cancel", "close"));
		return hints.join(theme.fg("borderMuted", " · "));
	}

	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.rebuildRows();
		this.selectedIndex = this.defaultSelectedIndex();
		this.renderHeader();
		this.filterRows(this.searchInput.getValue());
	}

	private rowSearchText(row: Row): string {
		if (row.kind === "provider") return row.provider;
		const defaultText = this.isDefaultModel(row.item.model) ? " default" : "";
		return `${getModelSelectorSearchText({ id: row.item.id, provider: row.item.provider, name: row.item.model.name })}${defaultText}`;
	}

	private isDefaultRow(row: Row): boolean {
		return row.kind === "model" && this.isDefaultModel(row.item.model);
	}

	private filterRows(query: string): void {
		if (!query) {
			this.filteredRows = this.rows;
		} else {
			const filtered = fuzzyFilter(this.rows, query, (row) => this.rowSearchText(row));
			if (this.isDefaultSearch(query)) {
				// Typing "default" (or a prefix of it) surfaces the default model even
				// when its name doesn't otherwise fuzzy-match the query.
				const defaultRows = this.rows.filter((row) => this.isDefaultRow(row));
				this.filteredRows = [...defaultRows, ...filtered.filter((row) => !this.isDefaultRow(row))];
			} else {
				this.filteredRows = filtered;
			}
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredRows.length - 1));
		this.updateList();
	}

	private renderRow(row: Row, isSelected: boolean): string {
		const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
		if (row.kind === "provider") {
			const label = isSelected ? theme.fg("accent", row.provider) : row.provider;
			const count = theme.fg("muted", ` (${row.count} model${row.count === 1 ? "" : "s"})`);
			const checkmark = row.hasCurrent ? theme.fg("success", " ✓") : "";
			return `${prefix}${label}${count}${checkmark}`;
		}
		const label = isSelected ? theme.fg("accent", row.item.id) : row.item.id;
		const showProvider = this.step.kind === "models" && this.step.provider === null;
		const badge = showProvider ? ` ${theme.fg("muted", `[${row.item.provider}]`)}` : "";
		const defaultBadge = this.isDefaultModel(row.item.model) ? theme.fg("muted", " · default") : "";
		const checkmark = modelsAreEqual(this.currentModel, row.item.model) ? theme.fg("success", " ✓") : "";
		return `${prefix}${label}${badge}${defaultBadge}${checkmark}`;
	}

	private updateList(): void {
		this.listContainer.clear();

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2), this.filteredRows.length - MAX_VISIBLE_ROWS),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, this.filteredRows.length);

		for (let i = startIndex; i < endIndex; i++) {
			const row = this.filteredRows[i];
			if (!row) continue;
			this.listContainer.addChild(new Text(this.renderRow(row, i === this.selectedIndex), 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredRows.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredRows.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredRows.length === 0) {
			const empty = this.step.kind === "providers" ? "  No matching providers" : "  No matching models";
			this.listContainer.addChild(new Text(theme.fg("muted", empty), 0, 0));
		} else {
			const selected = this.filteredRows[this.selectedIndex];
			if (selected?.kind === "model") {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.item.model.name}`), 0, 0));
			}
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredRows.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredRows.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredRows.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredRows.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmSelection();
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			// Escape steps back through the two levels; Ctrl+C always closes.
			if (matchesKey(keyData, Key.escape) && this.canGoBack()) {
				this.setStep({ kind: "providers" });
				return;
			}
			this.dispose();
			this.onCancelCallback();
		}
		// Ctrl+S — select and save as default
		else if (matchesKey(keyData, "ctrl+s") && this.onSelectAsDefaultCallback) {
			const row = this.filteredRows[this.selectedIndex];
			if (row?.kind === "model") {
				this.dispose();
				this.onSelectAsDefaultCallback(row.item.model);
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterRows(this.searchInput.getValue());
		}
	}

	private confirmSelection(): void {
		const row = this.filteredRows[this.selectedIndex];
		if (!row) return;
		if (row.kind === "provider") {
			this.setStep({ kind: "models", provider: row.provider });
			return;
		}
		this.handleSelect(row.item.model);
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
