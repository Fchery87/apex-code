import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * The footer recomputes usage totals by walking every session entry. With no
 * cache it did that on every frame (getEntries() itself copies the whole
 * list), so render cost grew with transcript size for the one component on
 * screen during every streaming frame. It must walk entries only when the
 * session's entry list has actually changed.
 */

type AssistantUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

function createCountingSession(options: { usage?: AssistantUsage; entriesVersion: { value: number } }): {
	session: AgentSession;
	getEntries: ReturnType<typeof vi.fn>;
} {
	const entries: Array<Record<string, unknown>> = [];
	if (options.usage) {
		entries.push({ type: "message", message: { role: "assistant", usage: options.usage } });
	}
	const getEntries = vi.fn(() => entries);

	const session = {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries,
			getEntriesVersion: () => options.entriesVersion.value,
			getSessionName: () => undefined,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 42 }),
		modelRuntime: { isUsingSubscription: () => false },
	};

	return { session: session as unknown as AgentSession, getEntries };
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("Footer usage caching", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("walks entries once across frames when entries are unchanged", () => {
		const version = { value: 1 };
		const usage: AssistantUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.1 } };
		const { session, getEntries } = createCountingSession({ usage, entriesVersion: version });
		const footer = new FooterComponent(session, createFooterData());

		footer.render(120);
		footer.render(120);
		footer.render(120);

		expect(getEntries).toHaveBeenCalledTimes(1);
	});

	it("re-walks entries when the session entry list changes", () => {
		const version = { value: 1 };
		const usage: AssistantUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.1 } };
		const { session, getEntries } = createCountingSession({ usage, entriesVersion: version });
		const footer = new FooterComponent(session, createFooterData());

		footer.render(120);
		version.value = 2;
		footer.render(120);

		expect(getEntries).toHaveBeenCalledTimes(2);
	});

	it("still shows fresh totals after the entries change", () => {
		const version = { value: 1 };
		const usage: AssistantUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.1 } };
		const { session } = createCountingSession({ usage, entriesVersion: version });
		const footer = new FooterComponent(session, createFooterData());

		footer.render(120);
		const before = stripAnsi(footer.render(120).join("\n"));

		version.value = 2;
		usage.input = 900;
		footer.render(120);
		const after = stripAnsi(footer.render(120).join("\n"));

		expect(after).not.toEqual(before);
		expect(after).toContain("900");
	});
});
