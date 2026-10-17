import { lookup as systemLookup } from "node:dns/promises";
import type { AgentToolResult } from "apex-code-agent-core";
import { minimatch } from "minimatch";
import TurndownService from "turndown";
import { type Static, Type } from "typebox";
import { Agent, fetch as undiciFetch } from "undici";
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

/** Largest body the tool reads. The model sees at most the truncated head of it. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Reads at most `limit` bytes and stops the download there. Reports whether it was cut short. */
async function readBodyCapped(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (received + value.byteLength > limit) {
			text += decoder.decode(value.subarray(0, limit - received), { stream: true });
			await reader.cancel();
			return { text: text + decoder.decode(), truncated: true };
		}
		received += value.byteLength;
		text += decoder.decode(value, { stream: true });
	}
	return { text: text + decoder.decode(), truncated: false };
}

const TEXTUAL_MEDIA = /^(text\/|application\/(json|xml|javascript|ld\+json)$|application\/[a-z0-9.+-]+\+(json|xml)$)/;
const HTML_MEDIA = new Set(["text/html", "application/xhtml+xml"]);

function mediaTypeOf(response: Response): string {
	return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Whether the model should read a body of this media type. An empty type is treated as text. */
function isReadable(mediaType: string): boolean {
	return mediaType === "" || HTML_MEDIA.has(mediaType) || TEXTUAL_MEDIA.test(mediaType);
}

/**
 * HTML becomes markdown, with the head, scripts, styles, and navigation removed. Other text
 * passes through unchanged.
 */
export function renderFetchedBody(mediaType: string, body: string): string {
	if (!HTML_MEDIA.has(mediaType)) return body;
	const withoutHead = body.replace(/<head[\s\S]*?<\/head>/i, "");
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.remove(["script", "style", "noscript", "nav"]);
	return turndown.turndown(withoutHead);
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipv4Octets(address: string): number[] | undefined {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!match) return undefined;
	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isBlockedIpv4([a, b, c]: number[]): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && c === 0)
	);
}

/** Expands an IPv6 literal to eight 16-bit groups, or undefined if it is not one. */
function ipv6Groups(address: string): number[] | undefined {
	const withoutZone = address.split("%")[0] ?? "";
	const halves = withoutZone.split("::");
	if (halves.length > 2) return undefined;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	const values = groups.map((group) => Number.parseInt(group, 16));
	return values.length === 8 && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
		? values
		: undefined;
}

/**
 * Whether an address is loopback, link-local, private, shared, or unspecified. IPv4-mapped
 * IPv6 addresses are judged by the IPv4 address they carry. Unrecognized text is refused,
 * because a value this check cannot read is not one it can vouch for.
 */
export function isBlockedAddress(address: string): boolean {
	const v4 = ipv4Octets(address);
	if (v4) return isBlockedIpv4(v4);
	const groups = ipv6Groups(address);
	if (!groups) return true;
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (mapped) return isBlockedIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
	const allZero = groups.every((group) => group === 0);
	const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
	const uniqueLocal = (groups[0] & 0xfe00) === 0xfc00;
	const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
	return allZero || loopback || uniqueLocal || linkLocal;
}

export interface ResolvedAddress {
	address: string;
	family: number;
}

/** Resolves a host to every address it currently maps to. Injected in tests. */
export type ResolveHost = (host: string) => Promise<ResolvedAddress[]>;

const systemResolveHost: ResolveHost = (host) => systemLookup(host, { all: true, verbatim: true });

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/** A configured proxy resolves the target itself, so the client cannot pin the address it checked. */
function proxyConfigured(): boolean {
	return PROXY_VARIABLES.some((name) => Boolean(process.env[name]));
}

/**
 * Refuses a URL before any request is sent: only http and https, and every address its
 * host resolves to must be public (unless the setting allows private destinations). Returns
 * the resolved addresses, so the connection can be pinned to the very addresses checked.
 * An IP literal resolves to itself.
 */
async function checkDestination(
	url: URL,
	allowPrivateNetwork: boolean,
	resolveHost: ResolveHost,
): Promise<ResolvedAddress[]> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`web_fetch refused: unsupported URL scheme ${url.protocol}, only http and https are supported.`);
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const addresses = await resolveHost(host);
	if (addresses.length === 0) throw new Error(`web_fetch could not resolve ${url.hostname}.`);
	if (!allowPrivateNetwork) {
		const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
		if (blocked) {
			throw new Error(
				`web_fetch refused ${url.hostname}: it resolves to ${blocked.address}, a private, loopback, or link-local address. Set webFetch.allowPrivateNetwork to allow it.`,
			);
		}
	}
	return addresses;
}

/**
 * A DNS lookup that answers only with the addresses already checked. The connection
 * therefore reaches the address the check passed, even if the name would now resolve
 * somewhere else (DNS rebinding).
 */
function pinnedLookup(addresses: readonly ResolvedAddress[]) {
	return (
		_hostname: string,
		options: { all?: boolean } | number | undefined,
		callback: (error: Error | null, address: unknown, family?: number) => void,
	) => {
		if (typeof options === "object" && options?.all) {
			callback(null, addresses);
			return;
		}
		callback(null, addresses[0].address, addresses[0].family);
	};
}

/**
 * Runs in the same process as every other tool. Redirects are followed by hand. A hop to a
 * different host is not followed: the target is returned as text, and the model's next call
 * to it goes through the permission gate.
 *
 * Without a proxy, each hop connects through an agent pinned to the addresses it checked.
 * With a proxy configured, the global proxy-aware fetch is used, and the check still runs
 * first, but the proxy resolves the target, so the address is not pinned.
 */
function createDefaultWebFetchOperations(allowPrivateNetwork: boolean, resolveHost: ResolveHost): WebFetchOperations {
	return {
		async fetch(url, signal) {
			let current = new URL(url);
			for (let hop = 0; ; hop++) {
				const addresses = await checkDestination(current, allowPrivateNetwork, resolveHost);
				const agent = proxyConfigured()
					? undefined
					: new Agent({ connect: { lookup: pinnedLookup(addresses) as never } });
				try {
					const requestSignal = signal
						? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
						: AbortSignal.timeout(FETCH_TIMEOUT_MS);
					const response = (agent
						? await undiciFetch(current.href, { signal: requestSignal, redirect: "manual", dispatcher: agent })
						: await globalThis.fetch(current.href, {
								signal: requestSignal,
								redirect: "manual",
							})) as unknown as Response;
					if (!REDIRECT_STATUSES.has(response.status)) {
						const mediaType = mediaTypeOf(response);
						if (!isReadable(mediaType)) {
							await response.body?.cancel();
							return {
								status: response.status,
								text: `web_fetch did not read this response: it is ${mediaType}, which is not text. Only text, markdown, HTML, and JSON are returned.`,
							};
						}
						const { text, truncated } = await readBodyCapped(response, MAX_BODY_BYTES);
						const body = renderFetchedBody(mediaType, text);
						return {
							status: response.status,
							text: truncated ? `${body}\n\n[truncated: the body exceeded ${MAX_BODY_BYTES} bytes]` : body,
						};
					}
					const location = response.headers.get("location");
					await response.body?.cancel();
					if (!location)
						return { status: response.status, text: "The server redirected without a Location header." };
					const next = new URL(location, current);
					if (next.host !== current.host) {
						return {
							status: response.status,
							text: `The server redirected to ${next.href}, a different host. Fetch that URL separately to continue.`,
						};
					}
					if (hop >= MAX_REDIRECTS)
						throw new Error(`web_fetch stopped: too many redirects (limit ${MAX_REDIRECTS}).`);
					current = next;
				} finally {
					await agent?.close();
				}
			}
		},
	};
}

export interface WebFetchToolOptions {
	operations?: WebFetchOperations;
	/** Allow loopback, private, and link-local destinations. Set from user settings only. */
	allowPrivateNetwork?: boolean;
	/** How hosts are resolved for the check and the pinned connection. The system resolver by default. */
	resolveHost?: ResolveHost;
}

function hostAndPath(url: string): string {
	const parsed = new URL(url);
	return `${parsed.hostname}${parsed.pathname}`;
}

export function createWebFetchToolDefinition(
	options?: WebFetchToolOptions,
): ApexToolDefinition<typeof webFetchSchema, WebFetchDetails> {
	const ops =
		options?.operations ??
		createDefaultWebFetchOperations(options?.allowPrivateNetwork === true, options?.resolveHost ?? systemResolveHost);
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
