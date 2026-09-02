import type { AgentBudgetLimit, AgentRunBudget, AgentRunBudgetController } from "./types.ts";

export type { AgentBudgetLimit, AgentRunBudget, AgentRunBudgetController } from "./types.ts";

/**
 * Create the stateful budget controller for one logical run (spec
 * 2026-09-01-tool-reliability-and-execution-budgets.md; defaults from
 * docs/research/2026-09-02-run-budget-measurements.md).
 *
 * Wall time starts when the controller is created — the logical run's start —
 * and is read at each budget gate. Counting boundary: a provider request is
 * one request the loop sends (retries and continuations included); transparent
 * retries inside the provider layer stay below this boundary. A tool call is
 * counted when the loop accepts it for execution.
 */
export function createRunBudgetController(
	policy: AgentRunBudget | undefined,
	options?: { now?: () => number },
): AgentRunBudgetController {
	const now = options?.now ?? Date.now;
	const maxProviderRequests = policy?.maxProviderRequests;
	const maxToolCalls = policy?.maxToolCalls;
	const maxWallTimeMs = policy?.maxWallTimeMs;
	const startedAt = now();

	let providerRequests = 0;
	let maintenanceRequests = 0;
	let toolCalls = 0;

	const exhaustedLimit = (): AgentBudgetLimit | undefined => {
		if (maxProviderRequests !== undefined && providerRequests >= maxProviderRequests) {
			return "provider-requests";
		}
		if (maxToolCalls !== undefined && toolCalls >= maxToolCalls) {
			return "tool-calls";
		}
		if (maxWallTimeMs !== undefined && now() - startedAt >= maxWallTimeMs) {
			return "wall-time";
		}
		return undefined;
	};

	const toolCallAcceptable = (): boolean => {
		// An already-sent request's batch is bounded by the tool-call and wall-time
		// limits only: the provider request was spent when it was gated, so the
		// provider-request bound must not fail calls that would otherwise complete it.
		if (maxToolCalls !== undefined && toolCalls >= maxToolCalls) {
			return false;
		}
		return !(maxWallTimeMs !== undefined && now() - startedAt >= maxWallTimeMs);
	};

	return {
		tryBeginProviderRequest() {
			if (exhaustedLimit() !== undefined) {
				return false;
			}
			providerRequests++;
			return true;
		},
		tryAcceptToolCall() {
			if (!toolCallAcceptable()) {
				return false;
			}
			toolCalls++;
			return true;
		},
		recordMaintenanceRequest() {
			maintenanceRequests++;
		},
		maintenanceRequests() {
			return maintenanceRequests;
		},
		exhaustedLimit,
	};
}
