import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Container, Terminal, TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Streaming updates must not re-parse markdown that has already rendered.
 *
 * Before this, every message_update re-created every Markdown child of the
 * streaming message, so the whole accumulated text (including syntax
 * highlighting) was re-parsed per chunk: measured at ~10.5 s of CPU to
 * stream one 32k-character message, and per-chunk cost growing linearly
 * with message size (quadratic overall).
 *
 * The fix splits streamed text into stable units (closed top-level code
 * fences, and paragraphs separated by blank lines) that keep their rendered
 * Markdown instances, re-parsing only the active tail. These tests pin the
 * two properties that matter:
 *
 * 1. Reuse: unchanged units keep component identity across updates.
 * 2. Equivalence: the split rendering is byte-identical to rendering the
 *    whole message through a single Markdown component, so no visual change
 *    ships with the performance fix.
 */

const WIDTH = 100;

class RecordingTerminal implements Terminal {
	columns = WIDTH;
	rows = 30;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function makeMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

/** Section components are the children of the component's content container. */
function sectionComponents(component: AssistantMessageComponent): Container["children"] {
	expect(component.children.length).toBe(1);
	const contentContainer = component.children[0] as Container;
	return contentContainer.children;
}

describe("AssistantMessageComponent streaming reuse", () => {
	let tui: TUI;

	beforeEach(() => {
		initTheme("dark");
		tui = new TuiMainScreen(new RecordingTerminal());
		tui.start();
	});

	it("keeps stable sections across streaming updates", () => {
		const component = new AssistantMessageComponent(undefined, false);
		tui.addChild(component);

		const stable = "First paragraph of the response.\n\nSecond paragraph with **bold** text.";
		component.updateContent(makeMessage(stable), true);
		const before = [...sectionComponents(component)];

		component.updateContent(makeMessage(`${stable}\n\nThird paragraph arrives.`), true);
		const after = sectionComponents(component);

		// The sections that existed before are still present, in place —
		// not re-created.
		expect(after.length).toBeGreaterThan(before.length);
		for (let i = 0; i < before.length; i++) {
			expect(after[i]).toBe(before[i]);
		}
	});

	it("reuses completed code-fence units and only re-parses the tail", () => {
		const component = new AssistantMessageComponent(undefined, false);
		tui.addChild(component);

		const fenced = "Intro text.\n\n```ts\nconst a = 1;\n```\n";
		component.updateContent(makeMessage(fenced), true);
		const before = [...sectionComponents(component)];

		component.updateContent(makeMessage(`${fenced}\nAfter the fence.`), true);
		const after = sectionComponents(component);

		// The intro paragraph and the closed fence both survived the update.
		expect(after.length).toBeGreaterThanOrEqual(3);
		for (let i = 0; i < before.length - 1; i++) {
			expect(after[i]).toBe(before[i]);
		}
	});

	it("rebuilds every section on invalidate so theme changes stay correct", () => {
		const component = new AssistantMessageComponent(undefined, false);
		tui.addChild(component);

		const text = "Paragraph one.\n\nParagraph two.";
		component.updateContent(makeMessage(text), true);
		const before = [...sectionComponents(component)];

		component.invalidate();
		const after = sectionComponents(component);
		expect(after.length).toBe(before.length);
		for (let i = 0; i < before.length; i++) {
			expect(after[i]).not.toBe(before[i]);
		}
	});

	it("split rendering is byte-identical to whole-message rendering", () => {
		const messageText = [
			"# Heading line",
			"",
			"Intro paragraph with a [link](https://example.com) and `code`.",
			"",
			"- list item one",
			"- list item two",
			"",
			"```ts",
			"const value = { a: 1, b: 2 };",
			"const other = value;",
			"```",
			"",
			"Closing paragraph after the fence.",
			"",
			"Another paragraph, long enough to wrap across the terminal width so the",
			"wrap logic is exercised by the equivalence check as well.",
		].join("\n");

		const streaming = new AssistantMessageComponent(undefined, false);
		tui.addChild(streaming);
		// Stream it in chunks the way message_update arrives.
		const chunkSize = 40;
		for (let i = chunkSize; i <= messageText.length; i += chunkSize) {
			streaming.updateContent(makeMessage(messageText.slice(0, i)), true);
		}
		streaming.updateContent(makeMessage(messageText), false);

		// Reference: one Markdown with the whole message, same theme/padding.
		const reference = new AssistantMessageComponent(makeMessage(messageText));
		tui.addChild(reference);

		expect(streaming.render(WIDTH)).toEqual(reference.render(WIDTH));
	});

	it("split rendering stays byte-identical when a markdown transformer is registered", () => {
		const messageText = [
			"Paragraph before the diagram.",
			"",
			"```mermaid",
			"graph TD; A-->B;",
			"```",
			"",
			"Paragraph after the diagram, long enough to need wrapping across the",
			"full terminal width in the equivalence comparison.",
		].join("\n");
		const transformer = (markdown: string): string => markdown;

		const streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [
			transformer,
		]);
		tui.addChild(streaming);
		const chunkSize = 35;
		for (let i = chunkSize; i <= messageText.length; i += chunkSize) {
			streaming.updateContent(makeMessage(messageText.slice(0, i)), true);
		}
		streaming.updateContent(makeMessage(messageText), false);

		const reference = new AssistantMessageComponent(
			makeMessage(messageText),
			false,
			getMarkdownTheme(),
			"Thinking...",
			1,
			[transformer],
		);
		tui.addChild(reference);

		expect(streaming.render(WIDTH)).toEqual(reference.render(WIDTH));
	});

	it("streams a long message in bounded time", () => {
		const component = new AssistantMessageComponent(undefined, false);
		tui.addChild(component);

		const paragraph = "Streaming paragraph with `inline code`, **emphasis**, and enough words to wrap. ";
		const code = "\n\n```ts\nexport function sample(input: string): string {\n\treturn input.trim();\n}\n```\n\n";
		const unit = paragraph + code;
		const full = unit.repeat(25); // ~20k chars
		let message = makeMessage("");
		const chunkSize = 120;

		const start = performance.now();
		for (let i = 0; i < full.length; i += chunkSize) {
			message = makeMessage(full.slice(0, i));
			component.updateContent(message, true);
			component.render(WIDTH);
		}
		const elapsed = performance.now() - start;

		// Coarse guard with generous headroom: the pre-fix quadratic behaviour
		// measured ~7 s for this volume; the stable-unit fix lands well under
		// 2 s on the same machine.
		expect(elapsed).toBeLessThan(4_000);
	}, 30_000);
});
