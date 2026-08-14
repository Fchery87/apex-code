import { minimatch } from "minimatch";
import { Type, type Static } from "typebox";
import type { AgentToolResult } from "apex-code-agent-core";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const webFetchSchema = Type.Object({
	url: Type.String({ description: "The absolute URL to fetch (including scheme, e.g. https://)." }),
});

export type WebFetchInput = Static<typeof webFetchSchema>;

export interface WebFetchDetails {
	url: string;
	status: number;
	truncated: boolean;
}

export interface WebFetchOperations {
	fetch(url: string, signal?: AbortSignal): Promise<{ status: number; text: string }>;
}

/**
 * Runs in the same process as every other tool -- the sandboxed child, not the
 * supervisor. `globalThis.fetch` is undici's global fetch, made proxy-aware by
 * `configureHttpDispatcher` (an `EnvHttpProxyAgent` reading HTTP_PROXY/HTTPS_PROXY)
 * at CLI startup, including in `core/sandbox/child-entry.ts`'s sandboxed launch.
 * That is what routes an allowed host through the sandbox's allowlist proxy and
 * leaves a disallowed one with no route at all -- this tool does not implement or
 * bypass that boundary itself; it only participates in it via the ordinary fetch
 * path, deliberately never opening a raw socket that could sidestep the proxy.
 */
const defaultWebFetchOperations: WebFetchOperations = {
	async fetch(url, signal) {
		const response = await fetch(url, { signal });
		return { status: response.status, text: await response.text() };
	},
};

function hostAndPath(url: string): string {
	const parsed = new URL(url);
	return `${parsed.hostname}${parsed.pathname}`;
}

export interface WebFetchToolOptions {
	operations?: WebFetchOperations;
}

export function createWebFetchToolDefinition(
	options?: WebFetchToolOptions,
): ApexToolDefinition<typeof webFetchSchema, WebFetchDetails> {
	const ops = options?.operations ?? defaultWebFetchOperations;
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: "Fetch the text contents of a URL over HTTP(S).",
		parameters: webFetchSchema,
		contract: {
			capabilities: new Set(["net"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent, params) => minimatch(hostAndPath(params.url), ruleContent, { dot: true }),
				describe: (ruleContent) => `Fetch URLs matching "${ruleContent}"`,
				ruleForCall: (params) => hostAndPath(params.url),
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(
			_toolCallId,
			{ url }: WebFetchInput,
			signal?: AbortSignal,
		): Promise<AgentToolResult<WebFetchDetails>> {
			const { status, text } = await ops.fetch(url, signal);
			const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES });
			const suffix = truncation.truncated
				? `\n\n[truncated: showing ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}]`
				: "";
			return {
				content: [{ type: "text", text: `${truncation.content}${suffix}` }],
				details: { url, status, truncated: truncation.truncated },
			};
		},
	};
}

export function createWebFetchTool(options?: WebFetchToolOptions) {
	return wrapToolDefinition(createWebFetchToolDefinition(options));
}
