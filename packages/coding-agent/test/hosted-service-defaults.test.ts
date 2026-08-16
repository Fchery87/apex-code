import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getShareViewerUrl } from "../src/config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const originalEnvironment = { ...process.env };

beforeEach(() => {
	process.env = { ...originalEnvironment };
	delete process.env.APEX_CODE_MODEL_CATALOG_URL;
	delete process.env.PI_MODEL_CATALOG_URL;
	delete process.env.APEX_CODE_SHARE_VIEWER_URL;
	delete process.env.PI_SHARE_VIEWER_URL;
});

afterEach(() => {
	process.env = { ...originalEnvironment };
	vi.restoreAllMocks();
});

describe("hosted-service defaults", () => {
	it("uses bundled models without selecting a remote catalog by default", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: true,
		});

		expect(runtime.getModels().length).toBeGreaterThan(0);
		expect(runtime.getProvider("anthropic")?.refreshModels).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("treats a blank catalog endpoint as unconfigured", async () => {
		process.env.APEX_CODE_MODEL_CATALOG_URL = "   ";
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: true,
		});
		expect(runtime.getProvider("anthropic")?.refreshModels).toBeUndefined();
	});

	it("uses only an explicitly configured catalog origin", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
			catalogBaseUrl: "https://catalog.example.test/base",
		});

		expect(runtime.getProvider("anthropic")?.refreshModels).toBeTypeOf("function");
	});

	it("accepts an explicit catalog endpoint from the Apex environment", async () => {
		process.env.APEX_CODE_MODEL_CATALOG_URL = "https://catalog.example.test/base";
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		});

		expect(runtime.getProvider("anthropic")?.refreshModels).toBeTypeOf("function");
	});

	it("has no share viewer unless the user configures one", () => {
		expect(getShareViewerUrl("gist-id")).toBeUndefined();
		process.env.APEX_CODE_SHARE_VIEWER_URL = "   ";
		expect(getShareViewerUrl("gist-id")).toBeUndefined();
	});

	it("uses the Apex viewer over the bounded legacy alias", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		process.env.PI_SHARE_VIEWER_URL = "https://legacy.example.test/session/";
		expect(getShareViewerUrl("gist-id")).toBe("https://legacy.example.test/session/#gist-id");
		process.env.APEX_CODE_SHARE_VIEWER_URL = "https://viewer.example.test/session/";
		expect(getShareViewerUrl("gist-id")).toBe("https://viewer.example.test/session/#gist-id");
	});

	it("rejects viewer schemes that can execute locally", () => {
		process.env.APEX_CODE_SHARE_VIEWER_URL = "javascript:alert(1)";
		expect(() => getShareViewerUrl("gist-id")).toThrow(/http or https/);
	});
});
