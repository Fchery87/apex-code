/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
	/**
	 * Name only the first binding. A hint sitting alongside several others has
	 * no room to list every alias, and "left/ctrl+b/right/ctrl+f effort" is
	 * longer than the thing it explains.
	 */
	primaryOnly?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding, options: KeyTextFormatOptions = {}): string {
	const keys = getKeybindings().getKeys(keybinding);
	return formatKeys(options.primaryOnly ? keys.slice(0, 1) : keys, options);
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}

/**
 * The one shape for "output is hidden here": `... (12 more lines, ctrl+o to expand)`.
 * `all` is a body collapsed to nothing. Empty when nothing is hidden, so a caller can
 * append it unconditionally.
 */
export function formatHiddenLines(count: number, position: "more" | "earlier" | "all"): string {
	if (count <= 0) return "";
	const noun = count === 1 ? "line" : "lines";
	const counted = position === "all" ? `${count} ${noun}` : `${count} ${position} ${noun}`;
	return `${theme.fg("muted", `... (${counted},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** How many lines a collapsed preview shows. Hiding one line would spend its row on the hint. */
export function previewLineCount(total: number, limit: number): number {
	return total <= limit + 1 ? total : limit;
}
