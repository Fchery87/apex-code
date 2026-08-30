import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type Terminal, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Red-loop harness for the two user-visible symptoms:
 *
 * 1. FLICKER: "the screen flicks up and down quickly while a session runs".
 *    In byte terms that is a violent repaint: a full-screen clear + scrollback
 *    wipe (0x1b[2J...0x1b[3J) or a large unsynchronized cursor jump. The loop
 *    counts those during a realistic streaming turn.
 *
 * 2. HEAVY: render cost per streaming frame should not grow with how much
 *    history is on screen, and the component tree should go quiet when the
 *    turn ends (no leaked animation timers re-rendering an idle transcript).
 */

const FULL_CLEAR = "\x1b[2J\x1b[H\x1b[3J";

class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = true;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	get fullClearCount(): number {
		return this.writes.filter((w) => w.includes(FULL_CLEAR)).length;
	}

	/** Total count of synchronized-output frame wrappers (both open and close). */
	get syncFrameMarkers(): number {
		return this.writes.reduce((n, w) => n + (w.match(/\x1b\[\?2026[hl]/g)?.length ?? 0), 0);
	}

	get bytesWritten(): number {
		return this.writes.reduce((n, w) => n + w.length, 0);
	}
}

function loadFixtureMessage(): AssistantMessage {
	const raw = JSON.parse(
		readFileSync(join(import.meta.dirname, "fixtures/assistant-message-with-thinking-code.json"), "utf-8"),
	) as AssistantMessage;
	return raw;
}

/** Split text into streaming-sized chunks the way SSE deltas arrive. */
function chunkText(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks;
}

describe("flicker red loop: streaming turn on TuiMainScreen", () => {
	let terminal: RecordingTerminal;
	let tui: TuiMainScreen;

	beforeEach(() => {
		initTheme("dark");
		terminal = new RecordingTerminal();
		tui = new TuiMainScreen(terminal);
	});

	function buildChatRoot(): { chat: Container; status: Container } {
		const root = new Container();
		const chat = new Container();
		const status = new Container();
		// Simulated editor dock: stable 3 lines, like the real composer.
		const editor = new Text(`${"─".repeat(98)}\n > \n${"─".repeat(98)}`, 0, 0);
		root.addChild(chat);
		root.addChild(status);
		root.addChild(editor);
		tui.addChild(root);
		return { chat, status };
	}

	it("streams a full assistant turn without any full-screen clear", () => {
		const { chat, status } = buildChatRoot();
		tui.start();
		tui.renderNow();
		const fullClearsAfterStart = terminal.fullClearCount;

		const fixture = loadFixtureMessage();
		const thinkingPart = fixture.content.find((c) => c.type === "thinking");
		const textPart = fixture.content.find((c) => c.type === "text");
		const thinkingText = thinkingPart && thinkingPart.type === "thinking" ? thinkingPart.thinking : "";
		const textText = textPart && textPart.type === "text" ? textPart.text : "";

		// agent_start: loader appears in the status area.
		const loaderText = new Text("⠋ Working... (esc to interrupt)", 1, 0);
		status.addChild(loaderText);

		const component = new AssistantMessageComponent(undefined, false);
		chat.addChild(component);

		let message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			timestamp: Date.now(),
		} as AssistantMessage;

		let frames = 0;
		const streamPart = (part: string, kind: "thinking" | "text") => {
			for (const chunk of chunkText(part, 12)) {
				if (kind === "thinking") {
					const existing = message.content[0];
					const previousThinking = existing.type === "thinking" ? existing.thinking : "";
					message = {
						...message,
						content: [{ type: "thinking", thinking: previousThinking + chunk }],
					} as AssistantMessage;
				} else {
					message = {
						...message,
						content: [...message.content, { type: "text", text: chunk }],
					} as AssistantMessage;
				}
				component.updateContent(message, true);
				// Spin the loader frame like its 80 ms interval would.
				loaderText.setText(`⠹ Working... (esc to interrupt)`);
				tui.renderNow();
				frames++;
			}
		};

		streamPart(thinkingText, "thinking");

		// Tool call begins mid-turn: its arguments stream in.
		const toolComponent = new ToolExecutionComponent(
			"read",
			"tool-call-loop-1",
			{ path: "/tmp/x.txt" },
			{},
			undefined,
			tui,
			tmpdir(),
		);
		chat.addChild(toolComponent);
		for (const argsFrame of [
			{ path: "/tmp/x.txt" },
			{ path: "/tmp/x.txt", offset: 1 },
			{ path: "/tmp/x.txt", offset: 1, limit: 50 },
		]) {
			toolComponent.updateArgs(argsFrame);
			tui.renderNow();
			frames++;
		}
		toolComponent.setArgsComplete();
		tui.renderNow();
		frames++;

		streamPart(textText, "text");

		// agent_end: loader removed.
		status.clear();
		tui.renderNow();
		frames++;

		const fullClearsDuringStream = terminal.fullClearCount - fullClearsAfterStart;
		const summary = {
			frames,
			fullClearsDuringStream,
			fullRedraws: tui.fullRedraws,
			syncFrameMarkers: terminal.syncFrameMarkers,
			kilobytesWritten: Math.round(terminal.bytesWritten / 1024),
		};
		console.log("[flicker-loop]", JSON.stringify(summary));

		expect(fullClearsDuringStream).toBe(0);
	});

	it("goes quiet after the turn ends (no leaked per-frame renders)", async () => {
		const { chat } = buildChatRoot();
		tui.start();
		tui.renderNow();

		const toolComponent = new ToolExecutionComponent(
			"bash",
			"tool-call-quiet-1",
			{ command: "echo hi" },
			{},
			undefined,
			tui,
			tmpdir(),
		);
		chat.addChild(toolComponent);
		toolComponent.setArgsComplete();
		toolComponent.updateResult(
			{
				content: [{ type: "text", text: "hi" }],
				isError: false,
			},
			false,
		);
		tui.renderNow();

		const writesBefore = terminal.writes.length;
		await new Promise((resolve) => setTimeout(resolve, 2300));
		const idleWrites = terminal.writes.length - writesBefore;

		console.log("[flicker-loop] idle writes over 2.3s after turn end:", idleWrites);
		// A turn that has ended must not keep pushing frames. Any requestRender
		// on a 1 s timer leaks here as extra writes.
		expect(idleWrites).toBe(0);
	});
});
