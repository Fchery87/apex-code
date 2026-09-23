import { type Component, Container } from "@earendil-works/pi-tui";

/** The composer draws its `›` prompt here, so everything that stands in for it starts here too. */
const DOCK_INSET = 2;

/**
 * The slot under the transcript that holds the composer, or whatever replaces it: a picker, a
 * dialog, a loader, an extension's component. It owns their left edge, so none of them has to
 * pad itself and they all start on the composer prompt's column.
 */
export class ComposerDock extends Container {
	private readonly getComposer: () => Component | undefined;

	constructor(getComposer: () => Component | undefined) {
		super();
		this.getComposer = getComposer;
	}

	override render(width: number): string[] {
		const [child] = this.children;
		if (this.children.length !== 1 || !child || child === this.getComposer()) return super.render(width);
		const inset = Math.min(DOCK_INSET, Math.max(0, width - 1));
		const pad = " ".repeat(inset);
		return child.render(width - inset).map((line) => pad + line);
	}
}
