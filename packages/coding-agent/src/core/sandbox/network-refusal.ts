/**
 * Turn a sandbox allowlist refusal into a message the user can act on.
 *
 * The child reaches the network only through the supervisor's CONNECT proxy, which
 * answers 403 for any host absent from `network.allowedHosts`. undici reports that as
 * `Proxy response (403) !== 200 when HTTP Tunneling`, but fetch surfaces only the
 * generic `fetch failed` at the top of the cause chain — so the caller sees a network
 * error with no host, no reason, and no remedy. Recovering the detail here is what
 * separates "something is broken" from "this host is not on the allowlist".
 */

/** undici's own wording for a tunnel the proxy declined to open. */
const TUNNEL_REFUSAL = /Proxy response \((\d+)\) !== 200 when HTTP Tunneling/;

const MAXIMUM_CAUSE_DEPTH = 8;

function findTunnelRefusal(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < MAXIMUM_CAUSE_DEPTH && current instanceof Error; depth++) {
		if (TUNNEL_REFUSAL.test(current.message)) return true;
		current = current.cause;
	}
	return false;
}

function hostFromUrl(url: string): string | undefined {
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}

/**
 * Describe a refused request, or return undefined when the failure was something else.
 * Only the sandboxed child installs this, so attributing the refusal to the sandbox
 * allowlist is accurate rather than a guess about whose proxy answered.
 */
export function describeSandboxNetworkRefusal(error: unknown, url: string): string | undefined {
	if (!findTunnelRefusal(error)) return undefined;
	const host = hostFromUrl(url);
	const subject = host ? `Host ${host} is` : "That host is";
	return `${subject} not on the sandbox network allowlist, so the request was refused. Add it to "network.allowedHosts" in your global Apex Code settings to permit it.`;
}

function requestUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input instanceof Request) return input.url;
	return "";
}

/**
 * Wrap global fetch so every caller — model providers, the version check, catalogs —
 * reports a refusal in the same actionable terms without each having to know the
 * sandbox exists. The original error is preserved as `cause`, and anything that is not
 * a refusal is rethrown untouched so retry and abort handling behave exactly as before.
 */
export function installSandboxNetworkRefusalMessages(): void {
	const wrapped = globalThis.fetch;
	globalThis.fetch = async function fetchWithRefusalDetail(input, init) {
		try {
			return await wrapped(input, init);
		} catch (error) {
			const description = describeSandboxNetworkRefusal(error, requestUrl(input));
			if (!description) throw error;
			throw new Error(description, { cause: error });
		}
	} as typeof globalThis.fetch;
}
