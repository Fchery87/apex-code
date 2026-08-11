import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const roleTempDir = join(tmpdir(), `pi-model-role-failover-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
	mkdirSync(roleTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(roleTempDir)) rmSync(roleTempDir, { recursive: true });
});

const p1 = createCredentialIdentity("p1");
const s1 = createCredentialIdentity("s1");
const p2 = createCredentialIdentity("p2");
const s2 = createCredentialIdentity("s2");

function authByRoleIdentity(identity: ReturnType<typeof createCredentialIdentity>): { apiKey?: string } | undefined {
	if (identity === p1) return { apiKey: "p1-key" };
	if (identity === s1) return { apiKey: "s1-key" };
	if (identity === p2) return { apiKey: "p2-key" };
	if (identity === s2) return { apiKey: "s2-key" };
	return undefined;
}

/** A role "default" resolving, in order, to primaryProviderId/model-a then secondaryProviderId/model-b, each with its own two-credential pool. */
async function createRoledRuntime(primaryProviderId: string, secondaryProviderId: string, testName: string) {
	const fauxA = fauxProvider({ provider: primaryProviderId, models: [{ id: "model-a" }] });
	const fauxB = fauxProvider({ provider: secondaryProviderId, models: [{ id: "model-b" }] });
	const pool = new CredentialPool({
		entries: [
			{ identity: p1, providerId: primaryProviderId },
			{ identity: s1, providerId: primaryProviderId },
			{ identity: p2, providerId: secondaryProviderId },
			{ identity: s2, providerId: secondaryProviderId },
		],
	});
	const modelsPath = join(roleTempDir, `${testName}.json`);
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {},
			roles: { default: { models: [`${primaryProviderId}/model-a`, `${secondaryProviderId}/model-b`] } },
		}),
		"utf-8",
	);

	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath,
		allowModelNetwork: false,
		credentialPool: pool,
		resolveCredentialPoolAuth: authByRoleIdentity,
	});
	runtime.registerNativeProvider(fauxA.provider);
	runtime.registerNativeProvider(fauxB.provider);
	await runtime.refresh({ allowNetwork: false, providers: [primaryProviderId, secondaryProviderId] });
	return { runtime, fauxA, fauxB, pool };
}

describe("ModelRuntime role-based model fallback (streamSimpleForRole)", () => {
	it("exhausts the primary candidate's credentials in order, then advances to the next candidate and completes", async () => {
		const { runtime, fauxA, fauxB, pool } = await createRoledRuntime("role-fb-a1", "role-fb-b1", "advance");
		const failA: FauxResponseFactory = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" });
		fauxA.setResponses([failA, failA]);
		fauxB.setResponses([fauxAssistantMessage("completed by role-fb-b1")]);

		const message = await runtime.streamSimpleForRole("default", { messages: [] }).result();

		expect(message.stopReason).toBe("stop");
		// Both of model-a's credentials were exhausted (in order) before model-b was tried once.
		expect(fauxA.state.callCount).toBe(2);
		expect(fauxB.state.callCount).toBe(1);
		const snapshot = pool.snapshot();
		expect(snapshot.find((entry) => entry.identity === p1)?.blockedUntil).toBeDefined();
		expect(snapshot.find((entry) => entry.identity === s1)?.blockedUntil).toBeDefined();
		// model-b's own credentials are untouched: no (credential, model) pair repeats.
		expect(snapshot.find((entry) => entry.identity === p2)?.blockedUntil).toBeUndefined();
		expect(snapshot.find((entry) => entry.identity === s2)?.blockedUntil).toBeUndefined();
	});

	it("preserves the original (first) failure when every candidate and credential fails", async () => {
		const { runtime, fauxA, fauxB } = await createRoledRuntime("role-fb-a2", "role-fb-b2", "all-fail");
		const failA: FauxResponseFactory = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 from role-fb-a2" });
		const failB: FauxResponseFactory = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 from role-fb-b2" });
		fauxA.setResponses([failA, failA]);
		fauxB.setResponses([failB, failB]);

		const message = await runtime.streamSimpleForRole("default", { messages: [] }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("429 from role-fb-a2");
		expect(fauxA.state.callCount).toBe(2);
		expect(fauxB.state.callCount).toBe(2);
	});

	it("does not fall back to the next candidate for a non-retryable error", async () => {
		const { runtime, fauxA, fauxB } = await createRoledRuntime("role-fb-a3", "role-fb-b3", "non-retryable");
		fauxA.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota: billing limit reached" }),
		]);
		fauxB.setResponses([fauxAssistantMessage("should never be reached")]);

		const message = await runtime.streamSimpleForRole("default", { messages: [] }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("insufficient_quota");
		expect(fauxA.state.callCount).toBe(1);
		expect(fauxB.state.callCount).toBe(0);
	});

	it("rejects an unknown role rather than silently falling back", async () => {
		const { runtime } = await createRoledRuntime("role-fb-a4", "role-fb-b4", "unknown-role");

		const message = await runtime.streamSimpleForRole("does-not-exist", { messages: [] }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("does-not-exist");
	});
});
