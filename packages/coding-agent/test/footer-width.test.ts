import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	usingSubscription?: boolean;
	percent?: number;
	cwd?: string;
}): AgentSession {
	const usage = options.usage;
	const entries: Array<Record<string, unknown>> = [];

	if (usage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage,
			},
		});
	}

	if (options.branchUsage !== undefined) {
		entries.push({
			type: "branch_summary",
			usage: options.branchUsage,
		});
	}

	if (options.compactionUsage !== undefined) {
		entries.push({
			type: "compaction",
			usage: options.compactionUsage,
		});
	}

	if (options.toolUsage !== undefined) {
		entries.push({
			type: "message",
			message: {
				role: "toolResult",
				usage: options.toolUsage,
			},
		});
	}

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => options.cwd ?? "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: options.percent ?? 12.3 }),
		modelRuntime: {
			isUsingSubscription: () => options.usingSubscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders compact mode as one responsive tray row", () => {
		const session = createSession({
			sessionName: "session",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 1_000,
				cacheWrite: 500,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const tray = stripAnsi(lines[0]);
		expect(tray).toContain("test-model");
		expect(tray).toContain("context 12.3%");
	});

	it("drops routine metadata before permission and context state", () => {
		const session = createSession({
			sessionName: "a very long session name",
			modelId: "a-very-long-model-name",
			provider: "a-very-long-provider-name",
			percent: 95,
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 1_000,
				cacheWrite: 500,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));
		footer.setPermissionMode("bypassPermissions");

		const tray = stripAnsi(footer.render(42)[0]);
		expect(tray).toContain("bypassPermissions");
		expect(tray).toContain("context 95.0%!!");
		expect(tray).not.toContain("CH");
		expect(tray).not.toContain("$1.234");
	});

	it("uses compact safety labels at very narrow widths without clipping them mid-segment", () => {
		const session = createSession({ sessionName: "", percent: 95 });
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setPermissionMode("bypassPermissions");

		const tray = stripAnsi(footer.render(24)[0]);
		expect(tray).toContain("bypass");
		expect(tray).toContain("ctx 95%!!");
		expect(tray).not.toContain("...");
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("includes summary and tool result usage in the total cost", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.5 },
			},
			branchUsage: {
				input: 20,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
			compactionUsage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.125 },
			},
			toolUsage: {
				input: 15,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.375 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120).join("\n"));
		expect(statsLine).toContain("$1.250");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(120).join("\n"));
		expect(statsLine).toContain("CH25.0%");
	});

	it("marks Kimi Coding costs as subscription estimates", () => {
		const session = createSession({
			sessionName: "",
			provider: "kimi-coding",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120).join("\n"))).toContain("$1.234 (sub)");
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createSession({ sessionName: "", provider: "anthropic", usingSubscription: true });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120).join("\n"))).toContain("$0.000 (sub)");
	});

	it("names every permission mode, including default", () => {
		const session = createSession({ sessionName: "", provider: "anthropic" });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120).join("\n"))).toContain("default");

		footer.setPermissionMode("bypassPermissions");
		expect(stripAnsi(footer.render(120).join("\n"))).toContain("bypassPermissions");

		footer.setPermissionMode("plan");
		const planned = stripAnsi(footer.render(120).join("\n"));
		expect(planned).toContain("plan");
		expect(planned).not.toContain("bypassPermissions");

		// Resetting must replace the old state rather than hiding permission posture.
		footer.setPermissionMode("default");
		const reset = stripAnsi(footer.render(120).join("\n"));
		expect(reset).toContain("default");
		expect(reset).not.toContain("bypassPermissions");
	});

	it("gives permission state first claim on every positive width", () => {
		const session = createSession({ sessionName: "", percent: 95 });
		const compactNames = {
			default: "default",
			plan: "plan",
			acceptEdits: "accept",
			bypassPermissions: "bypass",
			dontAsk: "dontAsk",
		} as const;

		for (const [mode, compactName] of Object.entries(compactNames)) {
			const footer = new FooterComponent(session, createFooterData(1));
			footer.setPermissionMode(mode as keyof typeof compactNames);
			for (const width of [120, 42, 24, 12, 7, 3, 2, 1]) {
				const line = stripAnsi(footer.render(width)[0] ?? "");
				const expectedPrefix = compactName.slice(0, Math.min(width, compactName.length));
				expect(line.startsWith(expectedPrefix), `${mode} at width ${width}`).toBe(true);
				expect(visibleWidth(line), `${mode} at width ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});

	it("gives permission state first claim in full token mode at every positive width", () => {
		const session = createSession({
			sessionName: "",
			percent: 95,
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 1_000,
				cacheWrite: 0,
				cost: { total: 1.5 },
			},
		});
		const compactNames = {
			default: "default",
			plan: "plan",
			acceptEdits: "acceptEdits",
			bypassPermissions: "bypassPermissions",
			dontAsk: "dontAsk",
		} as const;

		for (const [mode, name] of Object.entries(compactNames)) {
			const footer = new FooterComponent(session, createFooterData(1), {
				getSymbolPreset: () => "unicode",
				getColorBlindMode: () => false,
				getTokenUsageDisplay: () => "full",
			});
			footer.setPermissionMode(mode as keyof typeof compactNames);
			for (const width of [120, 42, 24, 12, 7, 3, 2, 1]) {
				const lines = footer.render(width).map(stripAnsi);
				const expectedPrefix = name.slice(0, Math.min(width, name.length));
				expect(
					lines.some((line) => line.startsWith(expectedPrefix)),
					`${mode} at width ${width}: ${JSON.stringify(lines)}`,
				).toBe(true);
				for (const line of lines) {
					expect(visibleWidth(line), `${mode} at width ${width}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("does not mark generic OAuth sign-in as a subscription", () => {
		const session = createSession({
			sessionName: "",
			provider: "openrouter",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120).join("\n"));

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});
