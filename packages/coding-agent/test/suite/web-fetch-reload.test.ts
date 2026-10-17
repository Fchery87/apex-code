import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const proxyVars = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

describe("web_fetch settings follow a reload", () => {
	const saved: Record<string, string | undefined> = {};
	const harnesses: Harness[] = [];

	beforeEach(() => {
		for (const name of proxyVars) {
			saved[name] = process.env[name];
			delete process.env[name];
		}
		process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
	});

	afterEach(() => {
		for (const name of proxyVars) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("refuses a proxied fetch after the user removes the opt-in and the session reloads", async () => {
		const harness = await createHarness({
			settings: { webFetch: { allowProxiedFetch: true } },
			webFetchAllowProxiedFetch: true,
		});
		harnesses.push(harness);
		expect(harness.session.getToolDefinition("web_fetch")).toBeDefined();

		vi.spyOn(harness.settingsManager, "getWebFetchAllowProxiedFetch").mockReturnValue(false);
		await harness.session.reload();

		const tool = harness.session.getToolDefinition("web_fetch");
		await expect(
			tool?.execute("call", { url: "https://example.com/" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/webFetch\.allowProxiedFetch/);
	});
});
