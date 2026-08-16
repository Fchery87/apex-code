import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialIdentity } from "../../src/core/credential-pool.ts";
import {
	buildOtlpTracePayload,
	buildUsageSampleSpan,
	exportUsageSampleSpan,
	OTLP_ALLOWED_ATTRIBUTE_KEYS,
} from "../../src/core/observability/otlp.ts";
import type { UsagePerformanceSample } from "../../src/core/usage-performance-store.ts";

function sample(overrides: Partial<UsagePerformanceSample> = {}): UsagePerformanceSample {
	return {
		timestamp: Date.parse("2026-08-16T00:00:00.000Z"),
		provider: "acme",
		model: "acme-large",
		role: "default",
		credentialIdentity: createCredentialIdentity("primary"),
		outcome: "success",
		ttftMs: 120,
		generationMs: 480,
		usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 },
		cost: 0.05,
		...overrides,
	};
}

describe("buildUsageSampleSpan", () => {
	it("includes only ADR 0012 allowlisted attribute keys", () => {
		const span = buildUsageSampleSpan(sample());
		const keys = span.attributes.map((a) => a.key);
		for (const key of keys) {
			expect(OTLP_ALLOWED_ATTRIBUTE_KEYS).toContain(key);
		}
		expect(keys).toContain("provider");
		expect(keys).toContain("model");
		expect(keys).toContain("cost");
	});

	it("never carries prompt content, tool arguments, or file paths -- those fields do not exist on the sample at all", () => {
		const span = buildUsageSampleSpan(sample());
		const serialized = JSON.stringify(span);
		expect(serialized).not.toMatch(/prompt|argv|filepath|\/home\/|\/Users\//i);
	});

	it("omits undefined optional fields rather than emitting null attributes", () => {
		const span = buildUsageSampleSpan(
			sample({ role: undefined, credentialIdentity: undefined, usage: undefined, cost: undefined }),
		);
		const keys = span.attributes.map((a) => a.key);
		expect(keys).not.toContain("role");
		expect(keys).not.toContain("credential_identity");
		expect(keys).not.toContain("cost");
	});
});

describe("buildOtlpTracePayload", () => {
	it("wraps spans in a well-formed OTLP resourceSpans/scopeSpans structure", () => {
		const payload = buildOtlpTracePayload([buildUsageSampleSpan(sample())]);
		expect(payload.resourceSpans).toHaveLength(1);
		expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
	});
});

describe("exportUsageSampleSpan", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("POSTs a well-formed OTLP/HTTP JSON payload to <endpoint>/v1/traces via global fetch", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

		await exportUsageSampleSpan(sample(), { endpoint: "http://localhost:4318" });

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe("http://localhost:4318/v1/traces");
		expect(init?.method).toBe("POST");
		const body = JSON.parse(String(init?.body));
		expect(body.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: { key: string }) => a.key)).toContain(
			"provider",
		);
	});

	it("never throws when the export request fails -- observability must not break a turn", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unreachable"));
		await expect(exportUsageSampleSpan(sample(), { endpoint: "http://localhost:4318" })).resolves.toBeUndefined();
	});
});
