import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createCredentialIdentity, CredentialPool } from "../src/core/credential-pool.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const primary = createCredentialIdentity("primary");
const secondary = createCredentialIdentity("secondary");

function authByIdentity(identity: ReturnType<typeof createCredentialIdentity>): { apiKey?: string } | undefined {
	if (identity === primary) return { apiKey: "primary-key" };
	if (identity === secondary) return { apiKey: "secondary-key" };
	return undefined;
}

async function createPooledRuntime(providerId: string, pool: CredentialPool) {
	const faux = fauxProvider({ provider: providerId });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
		credentialPool: pool,
		resolveCredentialPoolAuth: authByIdentity,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [providerId] });
	return { runtime, faux };
}

function twoEntryPool(providerId: string): CredentialPool {
	return new CredentialPool({
		entries: [
			{ identity: primary, providerId },
			{ identity: secondary, providerId },
		],
	});
}

describe("ModelRuntime credential failover", () => {
	it("rotates a classified 429 on the primary credential to a healthy secondary and completes the turn", async () => {
		const providerId = "pool-429";
		const pool = twoEntryPool(providerId);
		const { runtime, faux } = await createPooledRuntime(providerId, pool);

		const respond: FauxResponseFactory = (_context, options) =>
			options?.apiKey === "secondary-key"
				? fauxAssistantMessage("completed by secondary")
				: fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" });
		faux.setResponses([respond, respond]);

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }).result();

		expect(message.stopReason).toBe("stop");
		expect(faux.state.callCount).toBe(2);
		const snapshot = pool.snapshot();
		expect(snapshot.find((entry) => entry.identity === primary)?.blockedUntil).toBeDefined();
		expect(snapshot.find((entry) => entry.identity === secondary)?.blockedUntil).toBeUndefined();
	});

	it("never repeats a credential in one turn and preserves the original failure when every candidate fails", async () => {
		const providerId = "pool-all-fail";
		const pool = twoEntryPool(providerId);
		const { runtime, faux } = await createPooledRuntime(providerId, pool);

		const respond: FauxResponseFactory = (_context, options) =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: options?.apiKey === "primary-key" ? "429 Too Many Requests" : "401 Unauthorized",
			});
		faux.setResponses([respond, respond]);

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }).result();

		expect(message.stopReason).toBe("error");
		// The original (primary) failure is preserved, not the last (secondary) one.
		expect(message.errorMessage).toBe("429 Too Many Requests");
		expect(faux.state.callCount).toBe(2);
		// Both classified kinds (rate_limited, blocked) incur a cooldown; a "temporary"
		// classification deliberately does not (see credential-pool.test.ts).
		const snapshot = pool.snapshot();
		expect(snapshot.find((entry) => entry.identity === primary)?.blockedUntil).toBeDefined();
		expect(snapshot.find((entry) => entry.identity === secondary)?.blockedUntil).toBeDefined();
	});

	it("does not rotate for a non-retryable provider error such as quota exhaustion", async () => {
		const providerId = "pool-non-retryable";
		const pool = twoEntryPool(providerId);
		const { runtime, faux } = await createPooledRuntime(providerId, pool);

		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota: billing limit reached" }),
		]);

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("insufficient_quota");
		// Secondary is never attempted: the primary's failure was classified non-retryable.
		expect(faux.state.callCount).toBe(1);
		expect(pool.snapshot().find((entry) => entry.identity === secondary)?.blockedUntil).toBeUndefined();
	});

	it("does not attempt any credential when the request is already cancelled", async () => {
		const providerId = "pool-cancelled";
		const pool = twoEntryPool(providerId);
		const { runtime, faux } = await createPooledRuntime(providerId, pool);
		faux.setResponses([fauxAssistantMessage("unused")]);

		const controller = new AbortController();
		controller.abort();

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }, { signal: controller.signal }).result();

		expect(message.stopReason).toBe("error");
		expect(faux.state.callCount).toBe(0);
	});

	it("leaves single-credential providers with no configured pool entries unaffected", async () => {
		const providerId = "no-pool";
		// Pool exists (for a different provider) but has no entries for this one.
		const pool = twoEntryPool("some-other-provider");
		const { runtime, faux } = await createPooledRuntime(providerId, pool);
		faux.setResponses([fauxAssistantMessage("plain success")]);

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }).result();

		expect(message.stopReason).toBe("stop");
		expect(faux.state.callCount).toBe(1);
	});
});
