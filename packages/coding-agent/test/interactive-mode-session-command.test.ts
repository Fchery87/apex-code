import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { UsagePerformanceSample } from "../src/core/usage-performance-store.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

type Renderable = { render(width: number): string[] };

type SessionCommandContext = {
	session: {
		getSessionStats(): {
			sessionFile: string | undefined;
			sessionId: string;
			userMessages: number;
			assistantMessages: number;
			toolCalls: number;
			toolResults: number;
			totalMessages: number;
			tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			cost: number;
		};
		modelRuntime: {
			getModel(): undefined;
			listUsagePerformanceSamples(): Promise<readonly UsagePerformanceSample[]>;
		};
	};
	sessionManager: {
		getSessionName(): string | undefined;
		getEntries(): SessionEntry[];
	};
	chatContainer: { addChild: (child: unknown) => void };
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleSessionCommand(this: SessionCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function baseStats(overrides: Partial<SessionCommandContext["session"]["getSessionStats"]> = {}) {
	return {
		sessionFile: undefined,
		sessionId: "session-xyz",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
		cost: 0.15,
		...overrides,
	};
}

function sample(overrides: Partial<UsagePerformanceSample>): UsagePerformanceSample {
	return {
		timestamp: Date.now(),
		provider: "acme",
		model: "acme-large",
		outcome: "success",
		ttftMs: 100,
		generationMs: 200,
		sessionId: "session-xyz",
		...overrides,
	};
}

describe("InteractiveMode /session role and latency (task 8.4)", () => {
	it("adds Latency and Roles sections additively, without disturbing the existing Cost section", async () => {
		const addChild = vi.fn();
		const requestRender = vi.fn();

		const context: SessionCommandContext = {
			session: {
				getSessionStats: () => baseStats(),
				modelRuntime: {
					getModel: () => undefined,
					listUsagePerformanceSamples: async () => [
						sample({ role: "default", cost: 0.1, ttftMs: 100, generationMs: 200 }),
						sample({ role: "plan", cost: 0.05, ttftMs: 50, generationMs: 100 }),
						// A different session's row must never leak into this session's view.
						sample({ role: "default", cost: 99, sessionId: "other-session" }),
					],
				},
			},
			sessionManager: {
				getSessionName: () => undefined,
				getEntries: () => [],
			},
			chatContainer: { addChild },
			ui: { requestRender },
		};

		await interactiveModePrototype.handleSessionCommand.call(context);

		expect(requestRender).toHaveBeenCalledOnce();
		expect(addChild).toHaveBeenCalledTimes(2);

		const textComponent = addChild.mock.calls[1]?.[0] as Renderable;
		const rendered = textComponent.render(200).join("\n");

		// Existing behavior is untouched.
		expect(rendered).toContain("Cost");
		expect(rendered).toContain("Total:");
		expect(rendered).toContain("0.150");

		// New, additive content.
		expect(rendered).toContain("Latency");
		expect(rendered).toContain("Roles");
		expect(rendered).toContain("default");
		expect(rendered).toContain("plan");
		expect(rendered).toContain("0.100");
		expect(rendered).toContain("0.050");

		// The other session's row is excluded from this session's aggregate.
		expect(rendered).not.toContain("99.000");
		expect(rendered).not.toContain("other-session");
	});

	it("omits Latency/Roles sections entirely when the ledger has no samples for this session", async () => {
		const addChild = vi.fn();
		const context: SessionCommandContext = {
			session: {
				getSessionStats: () => baseStats({ cost: 0 }),
				modelRuntime: {
					getModel: () => undefined,
					listUsagePerformanceSamples: async () => [],
				},
			},
			sessionManager: {
				getSessionName: () => undefined,
				getEntries: () => [],
			},
			chatContainer: { addChild },
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleSessionCommand.call(context);

		const textComponent = addChild.mock.calls[1]?.[0] as Renderable;
		const rendered = textComponent.render(200).join("\n");
		expect(rendered).not.toContain("Latency");
		expect(rendered).not.toContain("Roles");
	});
});
