import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const UNAVAILABLE = "service_unavailable: The model service is temporarily unavailable.";

type HandleEvent = (this: unknown, event: AgentSessionEvent) => Promise<void>;

const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
const handleEvent = prototype.handleEvent as HandleEvent;

function createFakeInteractiveModeThis() {
	const chatContainer = new Container();
	return {
		chatContainer,
		isInitialized: true,
		outputPad: 1,
		hiddenThinkingLabel: "Thinking...",
		pendingTools: new Map(),
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		session: { retryAttempt: 0, abortRetry: vi.fn() },
		defaultEditor: { onEscape: undefined },
		clearPendingTools: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		isThinkingHidden: () => false,
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
		showStatusIndicator: (indicator: { dispose(): void }) => indicator.dispose(),
		clearStatusIndicator: vi.fn(),
		showError: prototype.showError,
	};
}

function failedAttempt(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: UNAVAILABLE,
		timestamp: Date.now(),
	};
}

async function fail(fakeThis: unknown): Promise<void> {
	const message = failedAttempt();
	await handleEvent.call(fakeThis, { type: "message_start", message });
	await handleEvent.call(fakeThis, { type: "message_end", message });
}

async function scheduleRetry(fakeThis: unknown, attempt: number): Promise<void> {
	await handleEvent.call(fakeThis, {
		type: "auto_retry_start",
		attempt,
		maxAttempts: 3,
		delayMs: 0,
		errorMessage: UNAVAILABLE,
	});
}

function errorLines(fakeThis: { chatContainer: Container }): string[] {
	return stripAnsi(fakeThis.chatContainer.render(200).join("\n"))
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("Error:"));
}

describe("a retried request in the chat", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("leaves one error line when every retry fails", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		await fail(fakeThis);
		for (const attempt of [1, 2, 3]) {
			await scheduleRetry(fakeThis, attempt);
			await fail(fakeThis);
		}
		await handleEvent.call(fakeThis, { type: "auto_retry_end", success: false, attempt: 3, finalError: UNAVAILABLE });

		expect(errorLines(fakeThis)).toEqual([`Error: ${UNAVAILABLE} (gave up after 3 retries)`]);
	});

	test("keeps the provider's error when the user cancels the wait", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		await fail(fakeThis);
		await scheduleRetry(fakeThis, 1);
		await handleEvent.call(fakeThis, {
			type: "auto_retry_end",
			success: false,
			attempt: 1,
			finalError: "Retry cancelled",
		});

		expect(errorLines(fakeThis)).toEqual([`Error: ${UNAVAILABLE} (retry cancelled)`]);
	});

	test("leaves no error line when a retry succeeds", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		await fail(fakeThis);
		await scheduleRetry(fakeThis, 1);
		await handleEvent.call(fakeThis, { type: "auto_retry_end", success: true, attempt: 1 });

		expect(errorLines(fakeThis)).toEqual([]);
	});
});
