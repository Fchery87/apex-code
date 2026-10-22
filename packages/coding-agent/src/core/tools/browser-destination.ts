const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Returns a refusal string, or null when the URL is an http(s) loopback target.
 * The host is compared literally. This function does not resolve DNS, so a name
 * that would resolve to loopback is still refused.
 */
export function browserDestinationRefusal(rawUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return `browser refused: "${rawUrl}" is not a URL.`;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `browser refused: unsupported URL scheme ${url.protocol}. Only http and https are supported.`;
	}
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (!LOOPBACK_HOSTS.has(host)) {
		return `browser refused ${url.hostname}: only localhost, 127.0.0.1, and ::1 are allowed.`;
	}
	return null;
}
