import type { AgentBudgetLimit, AgentRunBudget, AgentRunBudgetController, AgentRunBudgetUsage } from "./types.ts";

export type { AgentBudgetLimit, AgentRunBudget, AgentRunBudgetController, AgentRunBudgetUsage } from "./types.ts";

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
		usage(): AgentRunBudgetUsage {
			return { providerRequests, toolCalls, maintenanceRequests, startedAt };
		},
		exhaustedLimit,
	};
}

/**
 * Compose two controllers into one gate set (family budgets, spec
 * 2026-09-09-run-and-child-session-architecture.md, "Shared budgets"). The
 * primary is a run's own controller; the shared one is a family ceiling owned
 * by the caller (e.g. the delegating parent). A composite gate allows only
 * when BOTH allow, and only an accepted attempt is recorded, so a refusal
 * never consumes the other controller's counter.
 *
 * The decision runs before any recording, which is exact for stock controllers:
 * `exhaustedLimit()` is precisely the provider-request gate condition, and the
 * tool-call gate blocks on the tool-call and wall-time limits only, mirroring
 * `tryAcceptToolCall`'s documented rule that an already-sent request's batch is
 * not vetoed by the provider-request bound. A custom controller whose gates
 * disagree with `exhaustedLimit()` may see the other controller record an
 * attempt it then refuses itself; stock controllers never do.
 *
 * `exhaustedLimit` names the primary's reason first — the run's own exhaustion
 * is the more specific diagnosis, the family ceiling the fallback.
 */
export function createCompositeBudgetController(
	primary: AgentRunBudgetController,
	shared: AgentRunBudgetController,
): AgentRunBudgetController {
	const blocksProviderRequest = (controller: AgentRunBudgetController): boolean =>
		controller.exhaustedLimit() !== undefined;
	const blocksToolCall = (controller: AgentRunBudgetController): boolean => {
		const limit = controller.exhaustedLimit();
		return limit === "tool-calls" || limit === "wall-time";
	};

	return {
		tryBeginProviderRequest() {
			if (blocksProviderRequest(primary) || blocksProviderRequest(shared)) {
				return false;
			}
			// Both gates are open: record in both.
			return primary.tryBeginProviderRequest() && shared.tryBeginProviderRequest();
		},
		tryAcceptToolCall() {
			if (blocksToolCall(primary) || blocksToolCall(shared)) {
				return false;
			}
			return primary.tryAcceptToolCall() && shared.tryAcceptToolCall();
		},
		recordMaintenanceRequest() {
			primary.recordMaintenanceRequest();
			shared.recordMaintenanceRequest();
		},
		maintenanceRequests() {
			return primary.maintenanceRequests() + shared.maintenanceRequests();
		},
		usage() {
			const a = primary.usage();
			const b = shared.usage();
			return {
				providerRequests: a.providerRequests + b.providerRequests,
				toolCalls: a.toolCalls + b.toolCalls,
				maintenanceRequests: a.maintenanceRequests + b.maintenanceRequests,
				startedAt: Math.min(a.startedAt, b.startedAt),
			};
		},
		exhaustedLimit() {
			return primary.exhaustedLimit() ?? shared.exhaustedLimit();
		},
	};
}
