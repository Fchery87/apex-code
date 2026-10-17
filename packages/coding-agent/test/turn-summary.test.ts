import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function receiver() {
	const properties = {
		isInitialized: true,
		chatContainer: new Container(),
		footer: { invalidate: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn() },
		clearStatusIndicator: vi.fn(),
		clearPendingTools: vi.fn(),
		checkShutdownRequested: vi.fn(),
		showError: vi.fn(),
		defaultEditor: {},
	};
	return Object.defineProperties(
		Object.create(InteractiveMode.prototype),
		Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, { value, writable: true }])),
	);
}

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: ReturnType<typeof receiver>,
	event: AgentSessionEvent,
) => Promise<void>;

const start = { type: "turn_start" } as AgentSessionEvent;
const end = (options: Partial<Extract<AgentSessionEvent, { type: "agent_end" }>> = {}): AgentSessionEvent => ({
	type: "agent_end",
	messages: [],
	willRetry: false,
	stopReason: { kind: "completed" },
	...options,
});
const output = (mode: ReturnType<typeof receiver>) => stripAnsi(mode.chatContainer.render(120).join("\n"));

describe("turn summary", () => {
	beforeEach(() => {
		initTheme("dark");
		vi.spyOn(Date, "now").mockReturnValue(1000);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("the component renders both labels and hides sub-second durations", async () => {
		const { TurnSummaryComponent } = await import("../src/modes/interactive/components/turn-summary.ts");
		expect(new TurnSummaryComponent(999, "completed").render(120)).toEqual([]);
		expect(stripAnsi(new TurnSummaryComponent(1000, "completed").render(120).join("\n")).trim()).toBe(
			"Worked for 1s",
		);
		expect(stripAnsi(new TurnSummaryComponent(12000, "aborted").render(120).join("\n")).trim()).toBe(
			"Interrupted after 12s",
		);
	});

	test("renders one dim completed duration from the first step and preserves previous lines", async () => {
		const mode = receiver();
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(2000);
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(63500);
		await handleEvent.call(mode, end());
		expect(output(mode).trim()).toBe("Worked for 1m 2s");
		expect(mode.chatContainer.render(120).join("\n")).toContain("\u001b[");
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(65500);
		await handleEvent.call(mode, end());
		expect(output(mode)).toContain("Worked for 2s");
		expect(output(mode).match(/Worked for/g)).toHaveLength(2);
	});

	test("suppresses sub-second runs and ends without starts", async () => {
		const mode = receiver();
		await handleEvent.call(mode, end());
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(1999);
		await handleEvent.call(mode, end());
		expect(mode.chatContainer.children).toHaveLength(0);
	});

	test("renders interruption and uses structured outcomes before legacy messages", async () => {
		const mode = receiver();
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(13000);
		await handleEvent.call(mode, end({ stopReason: { kind: "aborted" } }));
		expect(output(mode)).toContain("Interrupted after 12s");
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(15000);
		const aborted = { role: "assistant", stopReason: "aborted" } as AssistantMessage;
		await handleEvent.call(mode, end({ messages: [aborted] }));
		expect(output(mode)).toContain("Worked for 2s");
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(18000);
		await handleEvent.call(mode, end({ messages: [aborted], stopReason: undefined }));
		expect(output(mode)).toContain("Interrupted after 3s");
	});

	test.each(["error", "budget-exhausted"] as const)("clears %s outcomes without a completion claim", async (kind) => {
		const mode = receiver();
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(6000);
		await handleEvent.call(
			mode,
			end({ stopReason: kind === "error" ? { kind } : { kind, limit: "provider-requests" } }),
		);
		expect(mode.chatContainer.children).toHaveLength(0);
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(8000);
		await handleEvent.call(mode, end());
		expect(output(mode)).toContain("Worked for 2s");
	});

	test("includes retry backoff in the final duration without an intermediate line", async () => {
		const mode = receiver();
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(4000);
		await handleEvent.call(mode, end({ willRetry: true, stopReason: { kind: "error" } }));
		expect(mode.chatContainer.children).toHaveLength(0);
		vi.mocked(Date.now).mockReturnValue(8000);
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(11000);
		await handleEvent.call(mode, end());
		expect(output(mode)).toContain("Worked for 10s");
	});

	test("renders retry cancellation from the typed outcome and starts the next run fresh", async () => {
		const mode = receiver();
		await handleEvent.call(mode, start);
		await handleEvent.call(mode, end({ willRetry: true, stopReason: { kind: "error" } }));
		vi.mocked(Date.now).mockReturnValue(13000);
		await handleEvent.call(mode, { type: "auto_retry_end", success: false, attempt: 1, aborted: true });
		expect(output(mode)).toContain("Interrupted after 12s");
		await handleEvent.call(mode, { type: "agent_settled" });
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(15000);
		await handleEvent.call(mode, end());
		expect(output(mode)).toContain("Worked for 2s");
	});

	test("settlement clears residual timing without rendering an extra line", async () => {
		const mode = receiver();
		await handleEvent.call(mode, start);
		await handleEvent.call(mode, { type: "agent_settled" });
		vi.mocked(Date.now).mockReturnValue(13000);
		await handleEvent.call(mode, start);
		vi.mocked(Date.now).mockReturnValue(15000);
		await handleEvent.call(mode, end());
		expect(output(mode)).toContain("Worked for 2s");
	});

	test("duration chrome does not change persisted entries or model context", async () => {
		const originalCwd = process.cwd();
		const scratch = mkdtempSync(join(tmpdir(), "apex-turn-summary-"));
		try {
			process.chdir(scratch);
			const manager = SessionManager.create(scratch, join(scratch, "sessions"));
			manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				content: [],
				stopReason: "stop",
				timestamp: 2,
			} as unknown as AssistantMessage);
			const entries = manager.getEntries();
			const context = manager.buildSessionContext();
			const file = manager.getSessionFile()!;
			const persisted = readFileSync(file, "utf8");
			const mode = receiver();
			Object.defineProperty(mode, "sessionManager", { value: manager });
			await handleEvent.call(mode, start);
			vi.mocked(Date.now).mockReturnValue(13000);
			await handleEvent.call(mode, end());
			expect(output(mode)).toContain("Worked for 12s");
			expect(manager.getEntries()).toEqual(entries);
			expect(manager.buildSessionContext()).toEqual(context);
			expect(readFileSync(file, "utf8")).toBe(persisted);
		} finally {
			process.chdir(originalCwd);
			rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	});
});
