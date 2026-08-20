import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { OTLP_ALLOWED_ATTRIBUTE_KEYS } from "../../src/core/observability/otlp.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

function scratchDir(label: string): string {
	const dir = join(tmpdir(), `apex-otlp-production-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("OTLP export through production wiring (task 8.5)", () => {
	// `AgentSessionServices.close()` is async (LSP.1 awaits pool/diagnostics teardown) --
	// this cleanup stack must await each entry or a later entry (deleting `agentDir`, the
	// state.sqlite file's own directory) can run before close() has actually released the
	// database handle. POSIX tolerates unlinking an open file; Windows does not, so an
	// unawaited close here reproduces as an EBUSY on `state.sqlite` in CI, not locally.
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	it("produces zero outbound requests attributable to observability when unconfigured", async () => {
		const agentDir = scratchDir("unconfigured");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const providerId = "otlp-unconfigured";
		const faux = fauxProvider({ provider: providerId });
		faux.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);

		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			sessionId: "session-otlp-unconfigured",
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		cleanups.push(() => services.close());
		services.modelRuntime.registerNativeProvider(faux.provider);
		await services.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });
		await services.modelRuntime.streamSimple(faux.getModel(), { messages: [] }).result();

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("emits a well-formed, allowlisted OTLP/HTTP payload when an endpoint is configured", async () => {
		const agentDir = scratchDir("configured");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const providerId = "otlp-configured";
		const faux = fauxProvider({ provider: providerId });
		faux.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

		const settingsManager = SettingsManager.create(agentDir, agentDir);
		settingsManager.applyOverrides({ observability: { otlpEndpoint: "http://localhost:4318" } });

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			sessionId: "session-otlp-configured",
			settingsManager,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		cleanups.push(() => services.close());
		services.modelRuntime.registerNativeProvider(faux.provider);
		await services.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });
		await services.modelRuntime.streamSimple(faux.getModel(), { messages: [] }).result();

		// The export is fire-and-forget (must never block or fail a turn); give its
		// microtask a tick to run.
		await new Promise((resolve) => setImmediate(resolve));

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe("http://localhost:4318/v1/traces");
		const payload = JSON.parse(String(init?.body));
		const attributeKeys: string[] = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes.map(
			(a: { key: string }) => a.key,
		);
		for (const key of attributeKeys) {
			expect(OTLP_ALLOWED_ATTRIBUTE_KEYS).toContain(key);
		}
		expect(attributeKeys).toContain("provider");
	});
});
