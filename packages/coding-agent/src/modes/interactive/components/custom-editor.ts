import { Editor, type EditorOptions, type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { stripAnsi } from "../../../utils/ansi.ts";

export interface CustomEditorOptions extends EditorOptions {
	/** Marker rendered at the start of the first input line, e.g. `"> "`. */
	promptPrefix?: string;
	/** Styles the prompt prefix. Defaults to leaving it unstyled. */
	promptColor?: (text: string) => string;
	/** Shown in place of the empty input line. */
	placeholder?: string;
	/** Styles the placeholder. Defaults to leaving it unstyled. */
	placeholderColor?: (text: string) => string;
}

/** Box-drawing horizontal rule: the first character of every border line. */
const BORDER_CHAR = "─";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 *
 * The prompt prefix and placeholder are layered on in `render` rather than
 * inside the base Editor, because `packages/tui` is frozen under ADR 0001 and
 * its `EditorOptions` has no hook for either.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private readonly promptPrefix: string;
	private readonly promptColor: (text: string) => string;
	private readonly placeholderColor: (text: string) => string;
	private placeholder: string | undefined;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.promptPrefix = options?.promptPrefix ?? "";
		this.promptColor = options?.promptColor ?? ((text) => text);
		this.placeholder = options?.placeholder;
		this.placeholderColor = options?.placeholderColor ?? ((text) => text);
	}

	setPlaceholder(placeholder: string | undefined): void {
		this.placeholder = placeholder;
	}

	override render(width: number): string[] {
		const prefixWidth = visibleWidth(this.promptPrefix);
		// Reserve the prefix out of the width handed to the base Editor, so its
		// wrapping, scrolling and cursor column all account for the space the
		// prefix occupies. Bail out entirely when the terminal cannot spare it.
		if (prefixWidth === 0 || width <= prefixWidth + 4) {
			return this.withPlaceholder(super.render(width));
		}

		const inner = this.withPlaceholder(super.render(width - prefixWidth));
		const borderPad = this.borderColor(BORDER_CHAR.repeat(prefixWidth));
		const blank = " ".repeat(prefixWidth);
		const styledPrefix = this.promptColor(this.promptPrefix);

		// Structure is: top border, content lines, bottom border, then optional
		// autocomplete rows. Counting borders tells the three regions apart
		// without depending on how many lines each contains.
		let borders = 0;
		let firstContentLine = true;
		return inner.map((line) => {
			if (this.isBorderLine(line)) {
				borders++;
				return borderPad + line;
			}
			if (borders !== 1) {
				// Autocomplete rows sit below the box; indent them to match.
				return blank + line;
			}
			if (firstContentLine) {
				firstContentLine = false;
				return styledPrefix + line;
			}
			return blank + line;
		});
	}

	private isBorderLine(line: string): boolean {
		return stripAnsi(line).startsWith(BORDER_CHAR);
	}

	/**
	 * Replace the sole content line with the placeholder while the input is
	 * empty. Index 1 is always the first content line, and an empty editor has
	 * exactly one, so no line classification is needed here.
	 */
	private withPlaceholder(lines: string[]): string[] {
		const placeholder = this.placeholder;
		if (!placeholder || lines.length < 2 || this.getText().length > 0 || this.isShowingAutocomplete()) {
			return lines;
		}
		const contentLine = lines[1];
		// Preserve the cursor cell when focused; unfocused there is none, and the
		// placeholder simply starts at column zero.
		const cursorCell = this.sliceLeadingCursorCell(contentLine);
		// Measure with visibleWidth alone. stripAnsi leaves the APC cursor marker
		// intact, so composing the two would count its bytes as seven columns.
		const available = visibleWidth(contentLine) - visibleWidth(cursorCell);
		if (available <= 0) {
			return lines;
		}
		const text = placeholder.slice(0, available);
		const padding = " ".repeat(Math.max(0, available - visibleWidth(text)));
		const updated = [...lines];
		updated[1] = cursorCell + this.placeholderColor(text) + padding;
		return updated;
	}

	/**
	 * The base Editor renders an empty line as the hardware-cursor marker
	 * followed by a reverse-video cell: `CURSOR_MARKER ESC[7m <space> ESC[0m`.
	 * Both parts are kept verbatim.
	 *
	 * The reverse-video run is matched explicitly rather than via a general
	 * leading-SGR match, which would consume the `ESC[7m` and leave reverse
	 * video open across the whole placeholder.
	 */
	private sliceLeadingCursorCell(line: string): string {
		const match = /^(?:\x1b_pi:c\x07)?(?:\x1b\[7m.\x1b\[(?:0|27)m)?/.exec(line);
		return match?.[0] ?? "";
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
