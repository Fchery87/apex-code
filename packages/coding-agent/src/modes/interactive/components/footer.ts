import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { PermissionMode } from "../../../core/permissions/store.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Accessibility/display settings the footer reads (roadmap Phase 8, task 8.6). */
export interface FooterAccessibilitySettings {
	getSymbolPreset(): "unicode" | "ascii";
	getColorBlindMode(): boolean;
	getTokenUsageDisplay(): "off" | "compact" | "full";
}

const DEFAULT_ACCESSIBILITY_SETTINGS: FooterAccessibilitySettings = {
	getSymbolPreset: () => "unicode",
	getColorBlindMode: () => false,
	getTokenUsageDisplay: () => "compact",
};

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~/${relativeToHome.replaceAll("\\", "/")}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private permissionMode: PermissionMode = "default";
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private accessibilitySettings: FooterAccessibilitySettings;

	constructor(
		session: AgentSession,
		footerData: ReadonlyFooterDataProvider,
		accessibilitySettings: FooterAccessibilitySettings = DEFAULT_ACCESSIBILITY_SETTINGS,
	) {
		this.session = session;
		this.footerData = footerData;
		this.accessibilitySettings = accessibilitySettings;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setPermissionMode(mode: PermissionMode): void {
		this.permissionMode = mode;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;
		const symbolPreset = this.accessibilitySettings.getSymbolPreset();
		const colorBlindMode = this.accessibilitySettings.getColorBlindMode();
		const tokenUsageDisplay = this.accessibilitySettings.getTokenUsageDisplay();
		const upSymbol = symbolPreset === "ascii" ? "^" : "↑";
		const downSymbol = symbolPreset === "ascii" ? "v" : "↓";
		const bulletSymbol = symbolPreset === "ascii" ? "-" : "•";

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} ${bulletSymbol} ${sessionName}`;
		}

		// Build stats line. tokenUsageDisplay: "off" hides this whole section
		// (context% and model name are separate and always shown); "full" shows
		// exact counts instead of formatTokens' abbreviation.
		const formatTokenCount = tokenUsageDisplay === "full" ? (n: number) => n.toLocaleString() : formatTokens;
		const statsParts = [];
		if (tokenUsageDisplay !== "off") {
			if (usageTotals.input) statsParts.push(`${upSymbol}${formatTokenCount(usageTotals.input)}`);
			if (usageTotals.output) statsParts.push(`${downSymbol}${formatTokenCount(usageTotals.output)}`);
			if (usageTotals.cacheRead) statsParts.push(`R${formatTokenCount(usageTotals.cacheRead)}`);
			if (usageTotals.cacheWrite) statsParts.push(`W${formatTokenCount(usageTotals.cacheWrite)}`);
			if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
				statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
			}
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (tokenUsageDisplay !== "off" && (usageTotals.cost || usingSubscription)) {
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// Context pressure is signalled through text at every setting -- never
		// color alone (WCAG 1.4.1) -- with color as an additional channel. The
		// default error/warning pair (red/amber) is already distinguishable for
		// most red-green colorblindness; colorBlindMode's palette adjustment
		// moves the critical (>90%) threshold to "accent" -- a hue outside that
		// red/amber family entirely -- rather than relying on a style attribute
		// like bold/underline, which several terminals (and this theme's own
		// chalk-backed style methods, suppressed outside a real TTY) silently
		// drop, making it an unreliable second channel.
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const pressureMarker = contextPercentValue > 90 ? "!!" : contextPercentValue > 70 ? "!" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%${pressureMarker}/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg(colorBlindMode ? "accent" : "error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", bulletSymbol)} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		// Permission posture is always named, including `default`. It is operational
		// state rather than routine telemetry: hiding the safe default would make the
		// tray change meaning by omission, while hiding bypass would conceal risk.
		// Text carries the signal and color remains a second channel (WCAG 1.4.1).
		const modeColor =
			this.permissionMode === "bypassPermissions" ? "error" : this.permissionMode === "default" ? "dim" : "warning";
		statsParts.unshift(theme.fg(modeColor, this.permissionMode));

		if (tokenUsageDisplay !== "full") {
			const separator = theme.fg("dim", symbolPreset === "ascii" ? " - " : " · ");
			const compactPermissionNames: Record<PermissionMode, string> = {
				default: "default",
				plan: "plan",
				acceptEdits: "accept",
				bypassPermissions: "bypass",
				dontAsk: "dontAsk",
			};
			const permissionColor =
				this.permissionMode === "bypassPermissions"
					? "error"
					: this.permissionMode === "default"
						? "dim"
						: "warning";
			const permissionFull = theme.fg(permissionColor, this.permissionMode);
			const permissionCompact = theme.fg(permissionColor, compactPermissionNames[this.permissionMode]);
			const compactPercent = contextPercent === "?" ? "?" : contextPercentValue.toFixed(0);
			const compactPressure = contextPercentValue > 90 ? "!!" : contextPercentValue > 70 ? "!" : "";
			const contextColor =
				contextPercentValue > 90
					? colorBlindMode
						? "accent"
						: "error"
					: contextPercentValue > 70
						? "warning"
						: "dim";
			const contextFull = theme.fg(contextColor, `context ${contextPercent}%${pressureMarker}`);
			const contextCompact = theme.fg(contextColor, `ctx ${compactPercent}%${compactPressure}`);

			const joinSegments = (segments: string[]): string => segments.join(separator);
			const fits = (segments: string[]): boolean => visibleWidth(joinSegments(segments)) <= width;
			let left: string[] = [permissionFull];
			let right = contextFull;

			if (!fits([...left, right])) {
				left = [permissionCompact];
				right = contextCompact;
			}

			if (!fits([...left, right])) {
				const safetyOnly = left[0];
				const line =
					visibleWidth(safetyOnly) <= width ? safetyOnly : truncateToWidth(safetyOnly, Math.max(0, width), "");
				return width > 0 ? [line] : [];
			}

			const optional: string[] = [];
			optional.push(theme.fg("dim", state.model?.id || "no-model"));
			if (state.model?.reasoning && state.thinkingLevel && state.thinkingLevel !== "off") {
				optional.push(theme.fg("dim", state.thinkingLevel));
			}
			if (tokenUsageDisplay !== "off" && (usageTotals.input || usageTotals.output)) {
				optional.push(
					theme.fg(
						"dim",
						`${upSymbol}${formatTokens(usageTotals.input)} ${downSymbol}${formatTokens(usageTotals.output)}`,
					),
				);
			}
			if (
				tokenUsageDisplay !== "off" &&
				(usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) &&
				latestCacheHitRate !== undefined
			) {
				optional.push(theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`));
			}
			if (tokenUsageDisplay !== "off" && (usageTotals.cost || usingSubscription)) {
				optional.push(theme.fg("dim", `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`));
			}
			if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
				optional.push(theme.fg("dim", state.model.provider));
			}
			if (areExperimentalFeaturesEnabled()) optional.push(theme.fg("warning", "xp"));
			optional.push(theme.fg("dim", pwd));

			for (const segment of optional) {
				if (fits([...left, segment, right])) left.push(segment);
			}

			const leftText = joinSegments(left);
			const padding = " ".repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(right)));
			const tray = leftText ? `${leftText}${padding}${right}` : right;
			const lines = [tray];
			const extensionStatuses = this.footerData.getExtensionStatuses();
			if (extensionStatuses.size > 0) {
				const sortedStatuses = Array.from(extensionStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text));
				lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "...")));
			}
			return lines;
		}

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			// Permission mode is the first segment and must remain textual at every
			// positive width. An ellipsis suffix can consume the entire narrow line.
			statsLeft = truncateToWidth(statsLeft, width, "");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off"
					? `${modelName} ${bulletSymbol} thinking off`
					: `${modelName} ${bulletSymbol} ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
