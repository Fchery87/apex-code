import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Dotted, so an overlay boundary never reads as the solid structural rule. */
const OVERLAY_RULE = "┄";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * It is the boundary every overlay draws, so it is deliberately quiet: a dotted
 * rule in `borderMuted` rather than a solid one in the brand accent. A
 * full-width accent rule above and below every selector made the accent the
 * loudest thing on screen in exactly the moment the user is reading a list.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private glyph: string;

	constructor(color: (str: string) => string = (str) => theme.fg("borderMuted", str), glyph = OVERLAY_RULE) {
		this.color = color;
		this.glyph = glyph;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		return [this.color(this.glyph.repeat(Math.max(1, width)))];
	}
}
