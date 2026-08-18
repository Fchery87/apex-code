import {
	CURSOR_MARKER,
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
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
	/** Styles a leading `/command` token. Defaults to leaving it unstyled. */
	commandColor?: (text: string) => string;
}

/** Box-drawing horizontal rule: the first character of every border line. */
const BORDER_CHAR = "─";

/**
 * A leading `/command` token: optional indent, a slash, then non-space.
 * Matched against the line's *visible* text, not the rendered string.
 */
const COMMAND_TOKEN = /^(\s*)(\/\S+)/;

/**
 * One ANSI control sequence: a CSI escape (`ESC [ … letter`) or the APC
 * hardware-cursor marker (`ESC _ … BEL`). Sticky, for position-by-position
 * scanning in {@link colorVisibleRange}.
 */
const CONTROL_SEQUENCE = /\x1b\[[0-9;]*[A-Za-z]|\x1b_[^\x07]*\x07/y;

/**
 * ============================ ANSI measuring hazards ============================
 *
 * Two traps live in the rendered strings this file post-processes. Both produced
 * real bugs; both are cheap to re-introduce. Read this before touching the width
 * maths or any leading-sequence match.
 *
 * 1. DO NOT COMPOSE `stripAnsi` WITH `visibleWidth`.
 *
 *    `stripAnsi` removes SGR colour codes but leaves the APC hardware-cursor
 *    marker (`ESC _pi:c BEL`, see CURSOR_MARKER in packages/tui) fully intact —
 *    all seven bytes of it. `visibleWidth` already handles that marker correctly
 *    and scores it zero.
 *
 *    So `visibleWidth(stripAnsi(line))` counts seven phantom columns on every
 *    line carrying a cursor, which silently widened each placeholder line past
 *    the terminal width. Measure with `visibleWidth` alone. Use `stripAnsi` only
 *    to read text, never to measure it.
 *
 * 2. DO NOT MATCH THE LEADING SEQUENCE RUN GENERICALLY.
 *
 *    The base Editor renders an empty line as:
 *        CURSOR_MARKER  ESC[7m  <space>  ESC[0m  <padding>
 *    The `ESC[7m` turns on reverse video for exactly the one-cell cursor block,
 *    and `ESC[0m` turns it back off.
 *
 *    A permissive prefix match such as `(?:\x1b\[[0-9;]*m)*` consumes that
 *    `ESC[7m` as though it were ordinary leading styling. Whatever is appended
 *    next then inherits reverse video, and because the matching `ESC[0m` was
 *    left behind in the discarded remainder, the inversion runs on through the
 *    placeholder and the rest of the frame. Match the reverse-video run
 *    explicitly instead — see {@link CustomEditor.sliceLeadingCursorCell}.
 *
 * ==============================================================================
 */

/**
 * Wrap the visible characters in `[start, end)` with `colorFn`, leaving every
 * control sequence in place.
 *
 * The range is in visible columns, so it is unaffected by however many escape
 * sequences are interleaved. That matters because the cursor cell can land in
 * the middle of the token being coloured: with the caret at column 3 of
 * `/model`, the line reads `/mo` + CURSOR_MARKER + `ESC[7m` + `d` + `ESC[0m` +
 * `el`. Colour is therefore re-opened after every control sequence rather than
 * once around the whole token, since the cursor cell's `ESC[0m` would otherwise
 * cancel it partway through.
 */
function colorVisibleRange(line: string, start: number, end: number, colorFn: (text: string) => string): string {
	let out = "";
	let buffer = "";
	let column = 0;
	let index = 0;

	const flush = () => {
		if (buffer) {
			out += colorFn(buffer);
			buffer = "";
		}
	};

	while (index < line.length) {
		CONTROL_SEQUENCE.lastIndex = index;
		const control = CONTROL_SEQUENCE.exec(line);
		if (control) {
			flush();
			out += control[0];
			index = CONTROL_SEQUENCE.lastIndex;
			continue;
		}
		const char = line[index];
		if (column >= start && column < end) {
			buffer += char;
		} else {
			flush();
			out += char;
		}
		column += visibleWidth(char);
		index += 1;
	}
	flush();
	return out;
}

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
	private readonly commandColor: ((text: string) => string) | undefined;
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
		this.commandColor = options?.commandColor;
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
			return this.withCommandColor(this.withPlaceholder(super.render(width)));
		}

		const inner = this.withCommandColor(this.withPlaceholder(super.render(width - prefixWidth)));
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
	 * Tint a leading `/command` on the first input line.
	 *
	 * The base Editor emits input text unstyled, so the only styling already
	 * present on the line is the cursor cell — which `colorVisibleRange` steps
	 * over. Only the command token is tinted; arguments after it stay plain, so
	 * the highlight marks what is being invoked rather than the whole line.
	 */
	private withCommandColor(lines: string[]): string[] {
		const commandColor = this.commandColor;
		if (!commandColor || lines.length < 2) {
			return lines;
		}
		// Read the token from the model rather than the rendered line: the first
		// visual row is the start of the text only when the caret has not scrolled
		// the view down, and getText is unambiguous either way.
		const firstLine = this.getText().split("\n", 1)[0] ?? "";
		const match = COMMAND_TOKEN.exec(firstLine);
		if (!match) {
			return lines;
		}
		const [, indent, token] = match;
		// The rendered row must still begin with that token, or the view has
		// scrolled and the highlight would land on unrelated text.
		if (!stripAnsi(lines[1].split(CURSOR_MARKER).join("")).startsWith(`${indent}${token}`)) {
			return lines;
		}
		const start = visibleWidth(indent);
		const updated = [...lines];
		updated[1] = colorVisibleRange(lines[1], start, start + visibleWidth(token), commandColor);
		return updated;
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
		// Measure with visibleWidth alone — never visibleWidth(stripAnsi(...)),
		// which scores the cursor marker as seven columns. See hazard 1 at the top
		// of this file.
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
	 * The `ESC[7m … ESC[0m` run is matched explicitly. Do not "simplify" this to
	 * a general leading-SGR match such as `(?:\x1b\[[0-9;]*m)*` — see hazard 2 at
	 * the top of this file for what that breaks.
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
