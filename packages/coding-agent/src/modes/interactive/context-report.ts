import type { SessionStats } from "../../core/agent-session.ts";
import type { ContextUsage } from "../../core/extensions/types.ts";

export interface ContextReportInput {
	usage: ContextUsage | undefined;
	stats: Pick<SessionStats, "tokens" | "cost">;
}

/** The context window, cache, and cost. No file path and no message counts: /session owns those. */
export function contextReport(input: ContextReportInput): string {
	const { usage, stats } = input;
	const window = usage
		? usage.tokens === null
			? `Context: unknown of ${usage.contextWindow.toLocaleString()} tokens`
			: `Context: ${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${usage.percent}%)`
		: "Context: no model selected";

	const prompt = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
	const cache =
		prompt > 0 ? `Cache: ${((stats.tokens.cacheRead / prompt) * 100).toFixed(1)}% read` : "Cache: no requests yet";
	const cost = `Cost: $${stats.cost.toFixed(3)}`;
	return [window, cache, cost].join("\n");
}
