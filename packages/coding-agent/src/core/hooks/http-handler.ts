import { parseHookDecisionOutput } from "./command-handler.ts";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	type HookEventPayload,
	type HookHandler,
	type HookHttpHandlerConfig,
	type HookOutcome,
} from "./types.ts";

/**
 * An HTTP handler POSTs the event payload and reads the decision from the 200
 * response body. The URL comes from settings only -- no environment-variable
 * interpolation into headers or URLs (spec, Non-goals). A non-200 response,
 * a transport failure, or a timeout is a failure outcome, which the runtime
 * turns into a fail-closed block on `tool_call`.
 */
export function httpHookHandler(config: HookHttpHandlerConfig): HookHandler {
	const timeoutMs = config.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
	return {
		async execute(payload: HookEventPayload): Promise<HookOutcome> {
			try {
				const response = await fetch(config.url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!response.ok) {
					return { ok: false, warning: `hook endpoint returned HTTP ${response.status}` };
				}
				return parseHookDecisionOutput(await response.text());
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/timeout|timed out|abort/i.test(message)) {
					return { ok: false, warning: `hook timed out after ${timeoutMs}ms` };
				}
				return { ok: false, warning: `hook request failed: ${message}` };
			}
		},
	};
}
