import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRawStdout } from "../src/core/output-guard.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

// Stdout is captured rather than written. The result envelope is part of the
// contract these tests pin, and reading it back from the real fd would make the
// assertion depend on the write queue draining.
vi.mock("../src/core/output-guard.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/output-guard.ts")>();
	return { ...actual, writeRawStdout: vi.fn(), flushRawStdout: vi.fn(async () => {}) };
});

/** The JSON lines print mode wrote, in order. */
function stdoutLines(): string[] {
	return vi
		.mocked(writeRawStdout)
		.mock.calls.map(([text]) => text.trimEnd())
		.filter((text) => text.length > 0);
}

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("reports a budget-exhausted stop from the structured stop reason", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		// A budget stop settles after a tool result: no assistant message carries
		// it, so print mode must surface it from the agent_end stop reason.
		let agentEndHandler:
			| ((event: {
					type: string;
					messages: unknown[];
					willRetry: boolean;
					stopReason?: unknown;
			  }) => Promise<void> | void)
			| undefined;
		session.subscribe = vi.fn((handler: (event: { type: string; stopReason?: unknown }) => Promise<void> | void) => {
			agentEndHandler = handler as typeof agentEndHandler;
			return () => {};
		});
		session.prompt = vi.fn(async () => {
			await agentEndHandler?.({
				type: "agent_end",
				messages: [],
				willRetry: false,
				stopReason: { kind: "budget-exhausted", limit: "provider-requests" },
			});
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "run tools",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(
			"Run stopped: the provider requests budget was exhausted (runBudget settings).",
		);
	});

	// The JSON exit contract. Every assertion below failed against the tree that
	// introduced it, because both exit-code assignments sat inside `if (mode ===
	// "text")`. A failed `--mode json` run returned 0 and wrote no terminal event.

	/** Drive the session so one `agent_end` carrying `stopReason` settles the run. */
	function settleWith(session: FakeSession, stopReason: unknown): void {
		type AgentEndEvent = { type: string; messages: unknown[]; willRetry: boolean; stopReason?: unknown };
		let agentEnd: ((event: AgentEndEvent) => Promise<void> | void) | undefined;
		session.subscribe = vi.fn((handler: (event: AgentEndEvent) => Promise<void> | void) => {
			agentEnd = handler;
			return () => {};
		});
		session.prompt = vi.fn(async () => {
			await agentEnd?.({ type: "agent_end", messages: [], willRetry: false, stopReason });
		});
	}

	/**
	 * The `result` envelope print mode writes last, or undefined when it wrote none.
	 * Text mode's last line is the assistant's prose, so a parse failure is an answer
	 * here rather than an error.
	 */
	function resultEvent(): { type: string; status: string } | undefined {
		const last = stdoutLines().at(-1);
		if (last === undefined) return undefined;
		let parsed: { type?: string; status?: string };
		try {
			parsed = JSON.parse(last) as { type?: string; status?: string };
		} catch {
			return undefined;
		}
		return parsed.type === "result" ? (parsed as { type: string; status: string }) : undefined;
	}

	it("returns non-zero on an assistant error in json mode", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		settleWith(runtimeHost.session, { kind: "error" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(1);
		expect(resultEvent()).toEqual({ type: "result", status: "error" });
	});

	it("returns non-zero on a budget-exhausted stop in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		settleWith(runtimeHost.session, { kind: "budget-exhausted", limit: "provider-requests" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "run tools",
		});

		expect(exitCode).toBe(1);
		expect(resultEvent()).toEqual({ type: "result", status: "budget-exhausted" });
	});

	it("returns non-zero in json mode when only the assistant message carries the error", async () => {
		// No agent_end reaches print mode here, so the outcome has to fall back to the
		// settled message. Without the fallback this run reports success.
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "aborted", errorMessage: "cancelled" }),
		);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(1);
		expect(resultEvent()).toEqual({ type: "result", status: "aborted" });
	});

	it("reports a completed run in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		settleWith(runtimeHost.session, { kind: "completed" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(0);
		expect(resultEvent()).toEqual({ type: "result", status: "completed" });
	});

	it("lets a completed stop reason outrank a stale errored message", async () => {
		// `agent_end` is authoritative, so a settled message left carrying an error
		// must not turn a completed run into a failure. Consulting the message
		// whenever the stop reason is merely not a failure reintroduces this.
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "stale failure" }),
		);
		settleWith(runtimeHost.session, { kind: "completed" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(0);
		expect(resultEvent()).toEqual({ type: "result", status: "completed" });
	});

	// Text mode's two moved edge cases, from the spec's second amendment. Both come
	// from the stop reason deciding instead of the last message, and both were
	// previously pinned in json mode only.

	it("fails a text run whose stop reason failed with no assistant message", async () => {
		// The base required `lastMessage?.role === "assistant"` before any failure
		// path, so an agent_end error with no such message exited 0.
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		runtimeHost.session.state.messages = [];
		settleWith(runtimeHost.session, { kind: "error" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("Request error");
	});

	it("passes a completed text run whose last message carries a stale error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "stale failure" }),
		);
		settleWith(runtimeHost.session, { kind: "completed" });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(0);
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it("writes no result envelope in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		settleWith(runtimeHost.session, { kind: "completed" });

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "say hi",
		});

		expect(exitCode).toBe(0);
		expect(resultEvent()).toBeUndefined();
	});
});
