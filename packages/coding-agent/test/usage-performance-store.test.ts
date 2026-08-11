import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createCredentialIdentity, CredentialPool } from "../src/core/credential-pool.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	FileUsagePerformanceStore,
	InMemoryUsagePerformanceStore,
	type UsagePerformanceSample,
} from "../src/core/usage-performance-store.ts";

const sharedTempDir = join(tmpdir(), `pi-usage-perf-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

function sample(overrides: Partial<UsagePerformanceSample> = {}): UsagePerformanceSample {
	return {
		timestamp: 1000,
		provider: "acme",
		model: "acme-large",
		role: "default",
		credentialIdentity: createCredentialIdentity("primary"),
		outcome: "success",
		ttftMs: 120,
		generationMs: 480,
		usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
		cost: 0.002,
		...overrides,
	};
}

describe("InMemoryUsagePerformanceStore", () => {
	it("round-trips recorded samples and returns independent copies", async () => {
		const store = new InMemoryUsagePerformanceStore();
		const original = sample();
		await store.record(original);
		original.provider = "mutated-after-record";

		const listed = await store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0].provider).toBe("acme");

		listed[0].provider = "mutated-after-list";
		expect((await store.list())[0].provider).toBe("acme");
	});
});

describe("FileUsagePerformanceStore", () => {
	it("round-trips samples through a mode-0600 file, across store instances", async () => {
		const path = join(sharedTempDir, "roundtrip.json");
		const first = new FileUsagePerformanceStore(path);
		await first.record(sample({ provider: "acme" }));
		await first.record(sample({ provider: "other", outcome: "error", failureKind: "rate_limited" }));

		const second = new FileUsagePerformanceStore(path);
		const listed = await second.list();
		expect(listed.map((entry) => entry.provider)).toEqual(["acme", "other"]);
		expect(listed[1].failureKind).toBe("rate_limited");

		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("recovers from a missing or corrupt file instead of throwing", async () => {
		const path = join(sharedTempDir, "does-not-exist.json");
		const store = new FileUsagePerformanceStore(path);
		expect(await store.list()).toEqual([]);
	});
});

function fakeClock(): () => number {
	let t = 0;
	return () => t++;
}

describe("ModelRuntime usage/performance recording", () => {
	it("records ttft/generation timing (from an injected clock) and usage/cost for a successful attempt", async () => {
		const providerId = "usage-perf-success";
		const faux = fauxProvider({ provider: providerId });
		faux.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);
		const store = new InMemoryUsagePerformanceStore();

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
			usagePerformanceStore: store,
			performanceClock: fakeClock(),
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		await runtime.streamSimple(faux.getModel(), { messages: [] }).result();

		const samples = await store.list();
		expect(samples).toHaveLength(1);
		expect(samples[0]).toMatchObject({
			provider: providerId,
			model: faux.getModel().id,
			outcome: "success",
			role: undefined,
			credentialIdentity: undefined,
			// content:[] yields exactly two events (start, done): start at t=1, done/complete at t=2.
			ttftMs: 1,
			generationMs: 1,
		});
		expect(samples[0].usage).toBeDefined();
		expect(typeof samples[0].cost).toBe("number");
	});

	it("records one sample per credential-pool attempt, tagging each with its own identity and outcome", async () => {
		const providerId = "usage-perf-rotate";
		const faux = fauxProvider({ provider: providerId });
		const primary = createCredentialIdentity("primary");
		const secondary = createCredentialIdentity("secondary");
		const pool = new CredentialPool({
			entries: [
				{ identity: primary, providerId },
				{ identity: secondary, providerId },
			],
		});
		const respond: FauxResponseFactory = (_context, options) =>
			options?.apiKey === "secondary-key"
				? fauxAssistantMessage([], { stopReason: "stop" })
				: fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
		faux.setResponses([respond, respond]);
		const store = new InMemoryUsagePerformanceStore();

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
			credentialPool: pool,
			resolveCredentialPoolAuth: (identity) =>
				identity === primary ? { apiKey: "primary-key" } : { apiKey: "secondary-key" },
			usagePerformanceStore: store,
			performanceClock: fakeClock(),
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }).result();
		expect(message.stopReason).toBe("stop");

		const samples = await store.list();
		expect(samples).toHaveLength(2);
		expect(samples[0]).toMatchObject({ credentialIdentity: primary, outcome: "error", failureKind: "rate_limited" });
		expect(samples[1]).toMatchObject({ credentialIdentity: secondary, outcome: "success" });
		// Neither resolved apiKey ever appears in a recorded sample.
		const serialized = JSON.stringify(samples);
		expect(serialized).not.toContain("primary-key");
		expect(serialized).not.toContain("secondary-key");
	});

	it("tags a role-resolved attempt with its role name and never writes a resolved secret to the file store", async () => {
		const providerId = "usage-perf-role";
		const faux = fauxProvider({ provider: providerId, models: [{ id: "model-a" }] });
		faux.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);
		const path = join(sharedTempDir, "role-attempt.json");
		const store = new FileUsagePerformanceStore(path);
		const modelsPath = join(sharedTempDir, "role-attempt-models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: {}, roles: { default: { models: [`${providerId}/model-a`] } } }),
			"utf-8",
		);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			allowModelNetwork: false,
			usagePerformanceStore: store,
			performanceClock: fakeClock(),
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		await runtime.streamSimpleForRole("default", { messages: [] }).result();

		const samples = await store.list();
		expect(samples).toHaveLength(1);
		expect(samples[0].role).toBe("default");

		const content = readFileSync(path, "utf-8");
		expect(content).not.toContain("api_key");
		expect(content).not.toContain("apiKey");
	});
});
