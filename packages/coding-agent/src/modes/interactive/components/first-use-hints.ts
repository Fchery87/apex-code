export type FirstUseHintId = "queue" | "tool-expand" | "thinking" | "bash";

const HINTS: Record<FirstUseHintId, string> = {
	queue: "Queued messages run after the current turn.",
	"tool-expand": "Use the tool expansion shortcut to see full output.",
	thinking: "Use the thinking shortcut to show or hide reasoning blocks.",
	bash: "Press Escape to leave bash input mode.",
};

export class FirstUseHints {
	private readonly seen: Set<FirstUseHintId>;

	constructor(seen: readonly string[] = []) {
		this.seen = new Set(seen.filter((hint): hint is FirstUseHintId => hint in HINTS));
	}

	offer(hint: FirstUseHintId): string | undefined {
		if (this.seen.has(hint)) return undefined;
		this.seen.add(hint);
		return HINTS[hint];
	}

	getSeen(): FirstUseHintId[] {
		return [...this.seen];
	}
}
