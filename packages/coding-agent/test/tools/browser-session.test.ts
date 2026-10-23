import { describe, expect, it } from "vitest";
import { type DevToolsEvent, openPage } from "../../src/core/tools/browser-session.ts";

describe("browser DevTools session", () => {
	it("opens the URL, returns the title, console, and screenshot, and blocks another host", async () => {
		const calls: string[] = [];
		const blocked: Array<Record<string, unknown>> = [];
		const page = await openPage(
			{
				request: async (method, params) => {
					calls.push(method);
					if (method === "Network.continueInterceptedRequest" && params) blocked.push(params);
					const events: DevToolsEvent[] =
						method === "Page.navigate"
							? [
									{
										method: "Network.requestIntercepted",
										params: {
											interceptionId: "block-me",
											request: { url: "https://example.com/tracker.js" },
										},
									},
									{ method: "Runtime.consoleAPICalled", params: { args: [{ value: "app ready" }] } },
									{ method: "Page.loadEventFired" },
								]
							: [];
					if (method === "Runtime.evaluate") return { result: { result: { value: "Inbox" } }, events };
					if (method === "Page.captureScreenshot") {
						return { result: { data: Buffer.from([1, 2, 3]).toString("base64") }, events };
					}
					return { result: {}, events };
				},
			},
			"http://127.0.0.1:3000/",
		);

		expect(calls).toContain("Page.navigate");
		expect(blocked[0]).toMatchObject({ interceptionId: "block-me", errorReason: "BlockedByClient" });
		expect(page.title).toBe("Inbox");
		expect(page.console).toContain("app ready");
		expect(page.screenshot).toEqual(new Uint8Array([1, 2, 3]));
	});
});
