import { Input } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Swap `pi-tui`'s `> ` input prompt for the composer's `›`. Both are two columns, so the
 * cursor column is unchanged. `Input` draws the prompt as the first two characters of its
 * first line, before any styling.
 */
export function withComposerPrompt(line: string): string {
	return line.startsWith("> ") ? `${theme.fg("accent", "›")} ${line.slice(2)}` : line;
}

/** An `Input` that uses the composer's prompt glyph, so every text field in Apex reads alike. */
export class PromptInput extends Input {
	override render(width: number): string[] {
		const [first, ...rest] = super.render(width);
		return first === undefined ? [] : [withComposerPrompt(first), ...rest];
	}
}
