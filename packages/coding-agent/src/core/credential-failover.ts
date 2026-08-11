/**
 * Pure helpers for bounded, pre-completion credential failover around
 * ModelRuntime.streamSimple(). Classification and stream buffering/replay only;
 * pool selection state lives in CredentialPool, request orchestration in ModelRuntime.
 */

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { CredentialFailureKind } from "./credential-pool.ts";

const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i;
const BLOCKED_CREDENTIAL_PATTERN = /\b401\b|\b403\b|unauthorized|forbidden|invalid.?api.?key|permission denied|expired/i;

/**
 * Classifies a failed AssistantMessage into a rotation-eligible CredentialFailureKind,
 * or undefined when the failure should not trigger credential rotation (success,
 * abort, or a non-retryable provider error such as quota exhaustion).
 */
export function classifyCredentialFailure(message: AssistantMessage): CredentialFailureKind | undefined {
	if (message.stopReason !== "error" || !message.errorMessage) return undefined;
	const text = message.errorMessage;
	if (RATE_LIMIT_PATTERN.test(text)) return "rate_limited";
	if (BLOCKED_CREDENTIAL_PATTERN.test(text)) return "blocked";
	if (isRetryableAssistantError(message)) return "temporary";
	return undefined;
}

/** An AsyncIterable<AssistantMessageEvent> paired with its eventual AssistantMessage, matching the shape `lazyStream` forwards. */
export interface ResultStream extends AsyncIterable<AssistantMessageEvent> {
	result(): Promise<AssistantMessage>;
}

export interface DrainedAttempt {
	events: readonly AssistantMessageEvent[];
	message: AssistantMessage;
}

/**
 * Fully consumes one attempt's stream before any event reaches the caller. This is
 * what makes a failed attempt invisible to the caller: nothing is forwarded until the
 * attempt's outcome (and therefore its retry eligibility) is known.
 */
export async function drainAttempt(stream: ResultStream): Promise<DrainedAttempt> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, message: await stream.result() };
}

/** Replays a fully-drained attempt's events as a fresh stream terminating in its known message. */
export function replayAttempt({ events, message }: DrainedAttempt): ResultStream {
	return {
		async *[Symbol.asyncIterator]() {
			yield* events;
		},
		result: () => Promise.resolve(message),
	};
}
