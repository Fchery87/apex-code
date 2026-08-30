import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const FENCE_OPENER = /^(```|~~~)/;
const FENCE_CLOSER = /^(```|~~~)\s*$/;
const LIST_MARKER = /^([-*+]\s|\d+[.)]\s)/;
const QUOTE_MARKER = /^>\s?/;
const INDENTED_CODE = /^(?:\t| {4})/;

function lastNonEmpty(lines: string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() !== "") return lines[i];
	}
	return undefined;
}

function shouldSplitBefore(next: string, current: string[]): boolean {
	// Indented lines can continue indented code blocks; never split there.
	if (INDENTED_CODE.test(next)) return false;
	const previous = lastNonEmpty(current);
	if (previous && INDENTED_CODE.test(previous)) return false;
	// A loose list ("item\n\nitem") and a blockquote with a blank line render
	// as one construct; splitting them would change the output.
	if (LIST_MARKER.test(next) && previous && LIST_MARKER.test(previous)) return false;
	if (QUOTE_MARKER.test(next) && previous && QUOTE_MARKER.test(previous)) return false;
	return true;
}

/**
 * Split streamed markdown into render units at boundaries that render
 * independently: closed column-0 code fences, and blank-line block
 * boundaries that cannot continue a preceding construct.
 *
 * The result is prefix-stable: appending text can only add units at the end,
 * never change earlier ones, which is what makes the units cacheable while
 * a message streams.
 */
export function splitStreamingMarkdown(text: string): string[] {
	if (!text) return [];
	const lines = text.split("\n");
	const units: string[] = [];
	let current: string[] = [];
	let inFence = false;
	const flush = (): void => {
		if (current.length > 0) {
			units.push(current.join("\n"));
			current = [];
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!inFence && FENCE_OPENER.test(line)) {
			inFence = true;
			current.push(line);
			continue;
		}
		if (inFence) {
			current.push(line);
			if (FENCE_CLOSER.test(line)) {
				flush();
				inFence = false;
			}
			continue;
		}
		current.push(line);
		if (line.trim() === "") {
			const next = lines[i + 1];
			if (next !== undefined && next.trim() !== "" && shouldSplitBefore(next, current)) {
				flush();
			}
		}
	}
	flush();
	return units;
}

type SectionSpec =
	| { kind: "spacer" }
	| { kind: "markdown-text"; text: string }
	| { kind: "markdown-thinking"; text: string }
	| { kind: "label"; text: string };

type Section = { spec: SectionSpec; component: Container["children"][number] };

function specText(spec: SectionSpec): string | undefined {
	return spec.kind === "spacer" ? undefined : spec.text;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private forceFullRebuild = true;
	private sections: Section[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.forceFullRebuild = true;
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.forceFullRebuild = true;
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.forceFullRebuild = true;
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.forceFullRebuild = true;
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		// The transform closures capture isStreaming, and non-streaming updates
		// render whole blocks rather than split units, so an isStreaming flip
		// rebuilds every section.
		const rebuildAll = this.forceFullRebuild || isStreaming !== this.isStreaming;
		this.isStreaming = isStreaming;

		const specs = this.buildSectionSpecs(message);
		const sections: Section[] = [];
		for (let i = 0; i < specs.length; i++) {
			const spec = specs[i];
			const previous = rebuildAll ? undefined : this.sections[i];
			const sameKind = previous !== undefined && previous.spec.kind === spec.kind;
			if (sameKind && (spec.kind === "spacer" || specText(previous.spec) === specText(spec))) {
				sections.push({ spec, component: previous.component });
				continue;
			}
			if (sameKind && spec.kind !== "spacer") {
				// Same slot, new content (the growing tail of a streamed
				// message): update in place so only this unit re-parses.
				const component = previous.component as Text;
				component.setText(specText(spec) ?? "");
				sections.push({ spec, component: previous.component });
				continue;
			}
			sections.push({ spec, component: this.createComponent(spec) });
		}

		this.forceFullRebuild = false;
		this.sections = sections;

		this.contentContainer.clear();
		for (const section of sections) {
			this.contentContainer.addChild(section.component);
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
	}

	private buildSectionSpecs(message: AssistantMessage): SectionSpec[] {
		const specs: SectionSpec[] = [];
		this.appendContentSpecs(message, specs);
		this.appendStatusSpecs(message, specs);
		return specs;
	}

	private appendContentSpecs(message: AssistantMessage, specs: SectionSpec[]): void {
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			specs.push({ kind: "spacer" });
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.pushMarkdownSpecs(specs, content.text.trim(), "markdown-text");
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					specs.push({
						kind: "label",
						text: theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
					});
				} else {
					// Render each run of thinking blocks as one Markdown section.
					this.pushMarkdownSpecs(specs, thinkingBlocks.join("\n\n"), "markdown-thinking");
				}
				if (hasVisibleContentAfter) {
					specs.push({ kind: "spacer" });
				}
			}
		}
	}

	private appendStatusSpecs(message: AssistantMessage, specs: SectionSpec[]): void {
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		if (message.stopReason === "length") {
			specs.push({ kind: "spacer" });
			specs.push({ kind: "label", text: theme.fg("error", "Response was truncated before completion.") });
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				specs.push({ kind: "spacer" });
				specs.push({ kind: "label", text: theme.fg("error", abortMessage) });
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				specs.push({ kind: "spacer" });
				specs.push({ kind: "label", text: theme.fg("error", `Error: ${errorMsg}`) });
			}
		}
	}

	/**
	 * Push markdown sections for one content block. While streaming, the block
	 * is split at render-independent boundaries so completed units keep their
	 * rendered Markdown instances and only the active tail re-parses per
	 * chunk; otherwise the block renders whole, byte-identical to the
	 * pre-split behaviour.
	 *
	 * Transformers are assumed block-local (the built-in mermaid transformer
	 * maps tokens and preserves the rest, so per-unit application is
	 * equivalent). A transformer that genuinely needs whole-message context
	 * still gets it: a non-streaming update always renders whole blocks.
	 */
	private pushMarkdownSpecs(specs: SectionSpec[], text: string, kind: "markdown-text" | "markdown-thinking"): void {
		if (this.isStreaming) {
			for (const unit of splitStreamingMarkdown(text)) {
				specs.push({ kind, text: unit });
			}
			return;
		}
		specs.push({ kind, text });
	}

	private createComponent(spec: SectionSpec): Section["component"] {
		switch (spec.kind) {
			case "spacer":
				return new Spacer(1);
			case "label":
				return new Text(spec.text, this.outputPad, 0);
			case "markdown-text":
				return new Markdown(spec.text, this.outputPad, 0, this.markdownTheme, undefined, {
					transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
				});
			case "markdown-thinking":
				return new Markdown(
					spec.text,
					this.outputPad,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					},
					{
						transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
					},
				);
		}
	}
}
