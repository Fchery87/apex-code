/**
 * The hook runtime: an immutable handler list keyed by event, plus the two
 * emission shapes the session seam consumes. Decision logic lives here so the
 * restriction-only rule is enforced in exactly one place -- `decideToolCall`
 * returns a block or nothing, never an allow that could bypass the gate.
 */

import type { HookEventName, HookHandler, HookRuntime } from "./types.ts";

export interface RuntimeHookEntry {
	event: HookEventName;
	handler: HookHandler;
}

function accepted(handler: HookHandler, toolName: string | undefined): boolean {
	if (!handler.matchesTool) return true;
	if (toolName === undefined) return true;
	return handler.matchesTool(toolName);
}

export function createHookRuntime(entries: RuntimeHookEntry[]): HookRuntime {
	const byEvent = new Map<HookEventName, HookHandler[]>();
	for (const entry of entries) {
		const handlers = byEvent.get(entry.event);
		if (handlers) {
			handlers.push(entry.handler);
		} else {
			byEvent.set(entry.event, [entry.handler]);
		}
	}

	return {
		hasHandlers(event) {
			return (byEvent.get(event)?.length ?? 0) > 0;
		},
		handlersFor(event) {
			return byEvent.get(event) ?? [];
		},
		async decideToolCall(toolName, payload) {
			for (const handler of byEvent.get("tool_call") ?? []) {
				if (!accepted(handler, toolName)) continue;
				const outcome = await handler.execute(payload);
				if (!outcome.ok) {
					// Fail closed: a hook that cannot run must not widen authority.
					// This is the spawn-failure and timeout path too.
					return { block: true, reason: outcome.warning };
				}
				// Restriction-only (spec): `block` short-circuits; `allow` and
				// `ask` fall through so the permission gate stays the last check.
				if (outcome.decision?.decision === "block") {
					return { block: true, reason: outcome.decision.reason ?? "blocked by a declarative hook" };
				}
			}
			return undefined;
		},
		async emitObserve(event, payload) {
			for (const handler of byEvent.get(event) ?? []) {
				if (!accepted(handler, payload.toolName)) continue;
				// Observe-only: awaited for ordering, but a failure is swallowed
				// because no decision is read from these events.
				const outcome = await handler.execute(payload);
				if (!outcome.ok) continue;
			}
		},
	};
}
