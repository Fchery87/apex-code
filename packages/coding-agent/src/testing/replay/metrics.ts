import type { AssistantMessage, Tool } from "@earendil-works/pi-ai";

/** The stable, provider-independent measurements emitted by an offline replay. */
export interface ReplayMetrics {
	contextTokensByTurn: number[];
	/** Estimated static provider input: the production system prompt plus tool schemas. */
	systemPromptTokens: number;
	cacheHitRate: number;
	toolCallsByName: Record<string, number>;
	/** Deterministic placeholder until recordings carry request durations. */
	wallTimeMs: number;
	costUsd: number;
	turnsCompleted: number;
}

export interface ReplayMetricsInput {
	systemPrompt: string;
	tools: readonly Tool[];
	recordedResponses: readonly AssistantMessage[];
	replayedResponses: readonly AssistantMessage[];
	contextTokensByTurn: readonly number[];
	turnsCompleted: number;
}

/** Build metrics from stable provider-boundary and replay output data. */
export function buildReplayMetrics(input: ReplayMetricsInput): ReplayMetrics {
	let inputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let costUsd = 0;
	for (const response of input.recordedResponses) {
		inputTokens += response.usage.input;
		cacheRead += response.usage.cacheRead;
		cacheWrite += response.usage.cacheWrite;
		costUsd += response.usage.cost.total;
	}
	const toolCallCounts = new Map<string, number>();
	for (const response of input.replayedResponses) {
		for (const part of response.content) {
			if (part.type === "toolCall") toolCallCounts.set(part.name, (toolCallCounts.get(part.name) ?? 0) + 1);
		}
	}
	const toolCallsByName = Object.fromEntries([...toolCallCounts.entries()].sort(([a], [b]) => a.localeCompare(b)));
	const staticProviderInput = `${input.systemPrompt}
${JSON.stringify(input.tools)}`;
	const promptTokens = inputTokens + cacheRead + cacheWrite;
	return {
		contextTokensByTurn: [...input.contextTokensByTurn],
		systemPromptTokens: Math.ceil(staticProviderInput.length / 4),
		cacheHitRate: promptTokens === 0 ? 0 : cacheRead / promptTokens,
		toolCallsByName,
		// A live timer would make the equality gate flaky; recordings do not yet carry durations.
		wallTimeMs: 0,
		costUsd,
		turnsCompleted: input.turnsCompleted,
	};
}
