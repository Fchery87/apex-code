import type { BrowserPage } from "./browser.ts";
import { browserDestinationRefusal } from "./browser-destination.ts";

export interface DevToolsConnection {
	/** Sends one command and resolves with the matching result. Events received meanwhile are returned alongside it. */
	request(method: string, params?: Record<string, unknown>): Promise<{ result: unknown; events: DevToolsEvent[] }>;
}

export interface DevToolsEvent {
	method: string;
	params?: {
		interceptionId?: string;
		request?: { url?: string };
		args?: Array<{ value?: unknown }>;
	};
}

function consoleLine(event: DevToolsEvent): string | undefined {
	if (event.method !== "Runtime.consoleAPICalled") return undefined;
	const text = (event.params?.args ?? []).map((arg) => String(arg.value ?? "")).join(" ");
	return text || undefined;
}

/**
 * One page open. The caller owns the connection. This function blocks a request whose host is
 * not loopback, waits for the load event, and reads the title and one screenshot.
 */
export async function openPage(connection: DevToolsConnection, url: string): Promise<BrowserPage> {
	const consoleLines: string[] = [];
	const blocks: Array<Promise<unknown>> = [];
	const collect = (events: readonly DevToolsEvent[]): boolean => {
		let loaded = false;
		for (const event of events) {
			const line = consoleLine(event);
			if (line) consoleLines.push(line);
			if (event.method === "Page.loadEventFired") loaded = true;
			if (event.method === "Network.requestIntercepted") {
				const target = event.params?.request?.url ?? "";
				const errorReason = browserDestinationRefusal(target) ? "BlockedByClient" : undefined;
				blocks.push(
					connection.request("Network.continueInterceptedRequest", {
						interceptionId: event.params?.interceptionId,
						...(errorReason ? { errorReason } : {}),
					}),
				);
			}
		}
		return loaded;
	};

	await connection.request("Network.setRequestInterception", { patterns: [{ urlPattern: "*" }] });
	let loaded = collect((await connection.request("Page.navigate", { url })).events);
	while (!loaded) {
		loaded = collect((await connection.request("Page.getFrameTree")).events);
	}
	await Promise.all(blocks);
	const title = (await connection.request("Runtime.evaluate", { expression: "document.title" })).result as {
		result?: { value?: string };
	};
	const shot = (await connection.request("Page.captureScreenshot", { format: "png" })).result as { data?: string };
	return {
		title: title.result?.value ?? "",
		finalUrl: url,
		console: consoleLines,
		screenshot: shot.data ? new Uint8Array(Buffer.from(shot.data, "base64")) : undefined,
	};
}
