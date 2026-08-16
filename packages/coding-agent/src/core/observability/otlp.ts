import { randomBytes } from "node:crypto";
import type { UsagePerformanceSample } from "../usage-performance-store.ts";

/**
 * User-directed OTLP trace export (roadmap Phase 8, ADR 0012). Uses global
 * `fetch` deliberately, not a direct undici import: `http-dispatcher.ts` already
 * binds it to a proxy-aware, timeout-configured dispatcher, and a second HTTP
 * client here would silently bypass a user's HTTP_PROXY.
 *
 * Scope note (recorded in the Phase 8 plan): this emits one span per model
 * request attempt -- the same unit `SqliteUsagePerformanceStore` already
 * records -- not a full turn/tool-call span tree. That would require touching
 * `agent-session.ts`'s tool-call lifecycle, a separate, larger integration this
 * phase does not open.
 */

export interface OtlpExportConfig {
	endpoint: string;
	headers?: Record<string, string>;
}

interface OtlpAttribute {
	key: string;
	value: { stringValue: string } | { doubleValue: number };
}

export interface OtlpSpan {
	traceId: string;
	spanId: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttribute[];
}

export interface OtlpTracePayload {
	resourceSpans: Array<{
		resource: { attributes: OtlpAttribute[] };
		scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
	}>;
}

const SERVICE_NAME = "apex-code";
/** OTLP SpanKind: SPAN_KIND_CLIENT -- this process is the caller of the model API. */
const SPAN_KIND_CLIENT = 3;

/**
 * The complete allowlist ADR 0012 permits. `buildUsageSampleSpan` only ever
 * emits a subset of this -- extending `UsagePerformanceSample` must not
 * silently widen what is exported; this list is edited explicitly or not at
 * all.
 */
export const OTLP_ALLOWED_ATTRIBUTE_KEYS = [
	"provider",
	"model",
	"role",
	"outcome",
	"failure_kind",
	"ttft_ms",
	"generation_ms",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cost",
	"credential_identity",
	"tool_name",
] as const;

function attr(key: string, value: string | number | undefined): OtlpAttribute | undefined {
	if (value === undefined) return undefined;
	return typeof value === "number" ? { key, value: { doubleValue: value } } : { key, value: { stringValue: value } };
}

function randomHex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

/** Builds one span for one model request attempt. Attributes are an allowlist, never a redaction pass. */
export function buildUsageSampleSpan(sample: UsagePerformanceSample): OtlpSpan {
	const attributes = [
		attr("provider", sample.provider),
		attr("model", sample.model),
		attr("role", sample.role),
		attr("outcome", sample.outcome),
		attr("failure_kind", sample.failureKind),
		attr("ttft_ms", sample.ttftMs),
		attr("generation_ms", sample.generationMs),
		attr("input_tokens", sample.usage?.input),
		attr("output_tokens", sample.usage?.output),
		attr("cache_read_tokens", sample.usage?.cacheRead),
		attr("cache_write_tokens", sample.usage?.cacheWrite),
		attr("cost", sample.cost),
		attr("credential_identity", sample.credentialIdentity),
	].filter((candidate): candidate is OtlpAttribute => candidate !== undefined);

	const startNanos = BigInt(sample.timestamp) * 1_000_000n;
	const durationMs = Math.max(0, Math.round(sample.ttftMs + sample.generationMs));
	const endNanos = startNanos + BigInt(durationMs) * 1_000_000n;

	return {
		traceId: randomHex(16),
		spanId: randomHex(8),
		name: "model_request_attempt",
		kind: SPAN_KIND_CLIENT,
		startTimeUnixNano: startNanos.toString(),
		endTimeUnixNano: endNanos.toString(),
		attributes,
	};
}

export function buildOtlpTracePayload(spans: readonly OtlpSpan[]): OtlpTracePayload {
	return {
		resourceSpans: [
			{
				resource: { attributes: [attr("service.name", SERVICE_NAME)!] },
				scopeSpans: [{ scope: { name: SERVICE_NAME }, spans: [...spans] }],
			},
		],
	};
}

/**
 * Exports one span for one usage sample. Never throws -- an export failure
 * must never fail the turn that produced the sample, matching
 * `instrumentAttempt`'s own fire-and-forget `.catch(() => {})` around the
 * ledger write.
 */
export async function exportUsageSampleSpan(sample: UsagePerformanceSample, config: OtlpExportConfig): Promise<void> {
	try {
		const payload = buildOtlpTracePayload([buildUsageSampleSpan(sample)]);
		const url = `${config.endpoint.replace(/\/$/, "")}/v1/traces`;
		await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...config.headers },
			body: JSON.stringify(payload),
		});
	} catch {
		// Never let an export failure surface to the caller.
	}
}
