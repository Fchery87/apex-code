import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFERRED_SCHEMA_STUB } from "../src/core/context/deferred-schemas.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("custom Responses tool compatibility", () => {
	let cwd: string;
	let previousCwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		cwd = mkdtempSync(join(tmpdir(), "apex-responses-compat-"));
		process.chdir(cwd);
		vi.stubEnv("APEX_CODE_EXPERIMENTAL", "0");
	});
	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(cwd, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it.each([undefined, true, false])(
		"sends non-strict tools unless strict mode is enabled: %s",
		async (supportsStrictMode) => {
			const modelsPath = join(cwd, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						gateway: {
							api: "openai-responses",
							baseUrl: "https://example.invalid/v1",
							models: [
								{ id: "astra", compat: supportsStrictMode === undefined ? undefined : { supportsStrictMode } },
							],
						},
					},
				}),
			);
			const registry = await createModelRegistry(
				AuthStorage.inMemory({ gateway: { type: "api_key", key: "offline-test" } }),
				modelsPath,
			);
			const model = registry.find("gateway", "astra");
			if (!model) throw new Error("Missing fixture model");
			const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Unexpected network"));
			let payload: unknown;
			const result = await registry.complete(
				model,
				{
					messages: [{ role: "user", content: "Run pwd", timestamp: Date.now() }],
					tools: [
						createBashTool(cwd),
						{ name: "mcp", description: "Deferred MCP tool", parameters: DEFERRED_SCHEMA_STUB },
					],
				},
				{
					fetch,
					onPayload(value) {
						payload = value;
						throw new Error("Captured before network");
					},
				},
			);
			expect(result.errorMessage).toBe("Captured before network");
			expect(fetch).not.toHaveBeenCalled();
			if (supportsStrictMode === false) {
				expect(payload).toMatchObject({
					tools: [
						expect.not.objectContaining({ strict: expect.anything() }),
						expect.not.objectContaining({ strict: expect.anything() }),
					],
				});
			} else {
				expect(payload).toMatchObject({
					tools: [
						{ name: "bash", strict: false },
						{ name: "mcp", strict: false },
					],
				});
			}
		},
	);

	it.each(["openai-completions", "anthropic-messages", "openai-codex-responses"])(
		"preserves compatibility defaults for %s",
		async (api) => {
			const modelsPath = join(cwd, "models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						gateway: {
							api,
							baseUrl: "https://example.invalid/v1",
							models: [{ id: "fixture" }],
						},
					},
				}),
			);
			const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
			expect(registry.find("gateway", "fixture")?.compat).toBeUndefined();
		},
	);

	it("preserves a provider opt-out and a model override on reload", async () => {
		const modelsPath = join(cwd, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						api: "openai-responses",
						baseUrl: "https://example.invalid/v1",
						compat: { supportsStrictMode: false },
						models: [{ id: "opt-out" }, { id: "override" }],
						modelOverrides: { override: { compat: { supportsStrictMode: true } } },
					},
				},
			}),
		);
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
		await registry.refresh({ allowNetwork: false });
		expect(registry.find("gateway", "opt-out")?.compat).toMatchObject({ supportsStrictMode: false });
		expect(registry.find("gateway", "override")?.compat).toMatchObject({ supportsStrictMode: true });
	});
});
