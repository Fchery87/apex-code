/**
 * Streaming render cost benchmark for the interactive main-screen path.
 *
 * Measures what one streaming frame costs (AssistantMessageComponent
 * updateContent + full TUI render) as the streamed message grows and as the
 * on-screen transcript grows. If per-frame cost is flat, the 16 ms frame
 * budget holds; if it grows with history, long sessions get glitchy and slow.
 *
 * Run with: npx tsx test/streaming-render-bench.ts
 */

import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type Terminal, Text } from "@earendil-works/pi-tui";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

// Production shape: interactive-mode always registers the mermaid transformer.
const productionTransformers = [createMermaidMarkdownTransformer({ getMode: () => "off" })];

class NullTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = true;
	bytes = 0;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += data.length;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function makeParagraph(id: number): string {
	return (
		`Paragraph ${id}: the renderer must keep up while this streams. ` +
		"It contains **bold**, `code spans`, and enough words to wrap across several terminal lines. ".repeat(3) +
		"\n\n```ts\nconst example = { id: " +
		id +
		", values: [1, 2, 3, 4, 5] };\n```\n\n"
	);
}

function makeMessage(thinkingChars: number, textChars: number): AssistantMessage {
	const thinking = "Reasoning about the task. ".repeat(Math.ceil(thinkingChars / 26)).slice(0, thinkingChars);
	const text = makeParagraph(0)
		.repeat(Math.max(1, Math.ceil(textChars / makeParagraph(0).length)))
		.slice(0, textChars);
	return {
		role: "assistant",
		content: [
			...(thinking ? [{ type: "thinking" as const, thinking }] : []),
			...(text ? [{ type: "text" as const, text }] : []),
		],
		timestamp: Date.now(),
		stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	} as unknown as AssistantMessage;
}

function ms(n: number): string {
	return n.toFixed(2).padStart(8);
}

async function main() {
	const terminal = new NullTerminal();

	console.log("=== Scenario 1: updateContent cost per streaming chunk (message grows) ===");
	console.log("message-chars  chunks  ms/chunk(mean)  ms/chunk(p95)  total-ms");
	for (const size of [2_000, 8_000, 32_000]) {
		const tui = new TuiMainScreen(terminal);
		const root = new Container();
		const chat = new Container();
		root.addChild(chat);
		tui.addChild(root);
		tui.start();
		tui.renderNow();

		const full = makeMessage(size / 2, size / 2);
		const thinkingText = (full.content[0] as { thinking: string }).thinking;
		const textText = (full.content[1] as { text: string }).text;

		const component = new AssistantMessageComponent(
			undefined,
			false,
			undefined,
			undefined,
			1,
			productionTransformers,
		);
		chat.addChild(component);
		let message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			timestamp: Date.now(),
		} as AssistantMessage;

		const samples: number[] = [];
		const feed = (kind: "thinking" | "text") => {
			const source = kind === "thinking" ? thinkingText : textText;
			const step = Math.max(1, Math.floor(size / 120));
			for (let i = 0; i < source.length; i += step) {
				if (kind === "thinking") {
					message = {
						...message,
						content: [{ type: "thinking", thinking: source.slice(0, i) }],
					} as AssistantMessage;
				} else {
					const rest = message.content.filter((c) => c.type !== "text");
					message = {
						...message,
						content: [...rest, { type: "text", text: source.slice(0, i) }],
					} as AssistantMessage;
				}
				const t0 = performance.now();
				component.updateContent(message, true);
				tui.renderNow();
				samples.push(performance.now() - t0);
			}
		};
		feed("thinking");
		feed("text");
		samples.sort((a, b) => a - b);
		const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
		const p95 = samples[Math.floor(samples.length * 0.95)];
		const total = samples.reduce((a, b) => a + b, 0);
		console.log(
			`${String(size).padStart(13)}  ${String(samples.length).padStart(6)}  ${ms(mean)}      ${ms(p95)}      ${ms(total)}`,
		);
		tui.stop();
	}

	console.log("\n=== Scenario 2: full-frame render cost vs transcript history (live streaming message on top) ===");
	console.log("history-msgs  history-lines  ms/frame(mean)  frames-behind-budget@16ms%");
	for (const history of [20, 100, 300]) {
		const tui = new TuiMainScreen(terminal);
		const root = new Container();
		const chat = new Container();
		root.addChild(chat);
		tui.addChild(root);

		// Historical messages: half assistant (with tool calls), half user.
		for (let i = 0; i < history; i++) {
			if (i % 2 === 0) {
				chat.addChild(new Text(`❯ user question number ${i} with some reasonable length of text`, 1, 0));
			} else {
				const msg = makeMessage(400, 1_500);
				const comp = new AssistantMessageComponent(msg);
				chat.addChild(comp);
				const tool = new ToolExecutionComponent(
					"read",
					`hist-${i}`,
					{ path: `/tmp/f${i}.ts` },
					{},
					undefined,
					tui,
					"/tmp",
				);
				tool.setArgsComplete();
				tool.updateResult(
					{ content: [{ type: "text", text: `file content ${i}\n`.repeat(40) }], isError: false },
					false,
				);
				chat.addChild(tool);
			}
		}

		// The message currently streaming.
		const streaming = new AssistantMessageComponent(
			undefined,
			false,
			undefined,
			undefined,
			1,
			productionTransformers,
		);
		chat.addChild(streaming);
		let message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			timestamp: Date.now(),
		} as AssistantMessage;
		tui.start();
		tui.renderNow();

		const samples: number[] = [];
		const textSource = makeParagraph(7).repeat(6);
		const step = Math.max(1, Math.floor(textSource.length / 60));
		for (let i = step; i <= textSource.length; i += step) {
			message = { ...message, content: [{ type: "text", text: textSource.slice(0, i) }] } as AssistantMessage;
			streaming.updateContent(message, true);
			const t0 = performance.now();
			tui.renderNow();
			samples.push(performance.now() - t0);
		}
		const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
		const overBudget = (100 * samples.filter((s) => s > 16).length) / samples.length;
		console.log(
			`${String(history).padStart(12)}  ${String(tui.render(100).length).padStart(13)}  ${ms(mean)}        ${overBudget.toFixed(1)}%`,
		);
		tui.stop();
	}

	console.log("\n=== Scenario 3: rebuildChatFromMessages equivalent (session restore / post-compaction) ===");
	console.log("history-msgs  rebuild-ms");
	for (const history of [20, 100, 300]) {
		const messages: AssistantMessage[] = [];
		for (let i = 0; i < history; i++) {
			messages.push(
				i % 2 === 0 ? (makeMessage(200, 800) as AssistantMessage) : (makeMessage(0, 1_200) as AssistantMessage),
			);
		}
		const tui = new TuiMainScreen(terminal);
		const root = new Container();
		const chat = new Container();
		root.addChild(chat);
		tui.addChild(root);
		tui.start();

		const t0 = performance.now();
		for (const m of messages) {
			const comp = new AssistantMessageComponent(m);
			chat.addChild(comp);
		}
		tui.renderNow();
		console.log(`${String(history).padStart(12)}  ${ms(performance.now() - t0)}`);
		tui.stop();
	}
}

await main();
