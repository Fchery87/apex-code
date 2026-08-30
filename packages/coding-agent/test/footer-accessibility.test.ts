import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };

function createSession(options: { percent?: number; sessionName?: string; usage?: AssistantUsage }): AgentSession {
	const entries: Array<Record<string, unknown>> = [];
	if (options.usage) {
		entries.push({ type: "message", message: { role: "assistant", usage: options.usage } });
	}

	const session = {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntriesVersion: () => 1,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: options.percent ?? 12.3 }),
		modelRuntime: { isUsingSubscription: () => false },
	};

	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

const bigUsage: AssistantUsage = { input: 12_345, output: 6_789, cacheRead: 1000, cacheWrite: 0, cost: { total: 1.5 } };

describe("Footer accessibility (task 8.6)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("signals context pressure through text, not color alone, at default settings", () => {
		const nominal = new FooterComponent(createSession({ percent: 50 }), createFooterData());
		const warning = new FooterComponent(createSession({ percent: 75 }), createFooterData());
		const critical = new FooterComponent(createSession({ percent: 95 }), createFooterData());

		const nominalPlain = stripAnsi(nominal.render(120).join("\n"));
		const warningPlain = stripAnsi(warning.render(120).join("\n"));
		const criticalPlain = stripAnsi(critical.render(120).join("\n"));

		// With color stripped, the three states must still be textually distinct.
		expect(warningPlain).not.toBe(nominalPlain.replace("50.0%", "75.0%"));
		expect(criticalPlain).not.toBe(nominalPlain.replace("50.0%", "95.0%"));
		expect(criticalPlain).not.toBe(warningPlain.replace("75.0%", "95.0%"));
	});

	it("renders pure ASCII with symbolPreset: ascii, including a big-usage stats line and a session-name separator", () => {
		const footer = new FooterComponent(
			createSession({ usage: bigUsage, sessionName: "my session" }),
			createFooterData(),
			{ getSymbolPreset: () => "ascii", getColorBlindMode: () => false, getTokenUsageDisplay: () => "compact" },
		);

		const rendered = footer.render(120).join("\n");
		for (const char of rendered) {
			expect(char.codePointAt(0)).toBeLessThanOrEqual(0x7f);
		}
	});

	it("defaults to unicode glyphs when no accessibility settings are provided", () => {
		const footer = new FooterComponent(createSession({ usage: bigUsage }), createFooterData());
		const rendered = stripAnsi(footer.render(120).join("\n"));
		expect(rendered).toContain("↑");
		expect(rendered).toContain("↓");
	});

	it("tokenUsageDisplay: off hides token/cost stats while keeping context% and model name", () => {
		const footer = new FooterComponent(createSession({ usage: bigUsage, percent: 50 }), createFooterData(), {
			getSymbolPreset: () => "unicode",
			getColorBlindMode: () => false,
			getTokenUsageDisplay: () => "off",
		});
		const rendered = stripAnsi(footer.render(120).join("\n"));
		expect(rendered).not.toContain("↑");
		expect(rendered).not.toContain("$1.500");
		expect(rendered).toContain("50.0%");
		expect(rendered).toContain("test-model");
		expect(rendered).toContain("default");
	});

	it("tokenUsageDisplay: full shows exact token counts instead of abbreviated ones", () => {
		const footer = new FooterComponent(createSession({ usage: bigUsage }), createFooterData(), {
			getSymbolPreset: () => "unicode",
			getColorBlindMode: () => false,
			getTokenUsageDisplay: () => "full",
		});
		const rendered = stripAnsi(footer.render(120).join("\n"));
		expect(rendered).toContain("12,345");
		expect(rendered).not.toContain("12k");
	});

	it("tokenUsageDisplay: compact (default) keeps the existing abbreviated behavior", () => {
		const footer = new FooterComponent(createSession({ usage: bigUsage }), createFooterData());
		const rendered = stripAnsi(footer.render(120).join("\n"));
		expect(rendered).toContain("12k");
		expect(rendered).not.toContain("12,345");
	});

	it("colorBlindMode adjusts the palette (moves the critical threshold to a distinct hue) without changing the underlying text", () => {
		const plainFooter = new FooterComponent(createSession({ percent: 95 }), createFooterData(), {
			getSymbolPreset: () => "unicode",
			getColorBlindMode: () => false,
			getTokenUsageDisplay: () => "compact",
		});
		const colorBlindFooter = new FooterComponent(createSession({ percent: 95 }), createFooterData(), {
			getSymbolPreset: () => "unicode",
			getColorBlindMode: () => true,
			getTokenUsageDisplay: () => "compact",
		});

		const plainRendered = plainFooter.render(120).join("\n");
		const colorBlindRendered = colorBlindFooter.render(120).join("\n");

		// Same text once color/weight is stripped...
		expect(stripAnsi(plainRendered)).toBe(stripAnsi(colorBlindRendered));
		// ...but the raw ANSI-carrying output differs (a real palette adjustment, not a no-op).
		expect(colorBlindRendered).not.toBe(plainRendered);
	});
});
