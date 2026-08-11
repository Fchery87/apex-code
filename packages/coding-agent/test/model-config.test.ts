import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";

const sharedTempDir = join(tmpdir(), `pi-model-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const LITERAL_SENTINEL = "sk-legacy-literal-secret-sentinel";
const ENV_VAR_NAME = "APEX_MODEL_CONFIG_TEST_SENTINEL";
const RESOLVED_ENV_SENTINEL = "resolved-env-secret-sentinel";
const COMMAND_SENTINEL = "resolved-command-secret-sentinel";

function legacyModelsJson(): Record<string, unknown> {
	return {
		providers: {
			literal: {
				name: "Literal",
				baseUrl: "https://example.test/v1",
				apiKey: LITERAL_SENTINEL,
			},
			env: {
				name: "Env",
				baseUrl: "https://example.test/v1",
				apiKey: `$${ENV_VAR_NAME}`,
			},
			command: {
				name: "Command",
				baseUrl: "https://example.test/v1",
				apiKey: `!echo ${COMMAND_SENTINEL}`,
			},
		},
	};
}

function writeModelsJson(path: string): void {
	writeFileSync(path, JSON.stringify(legacyModelsJson(), null, 2), "utf-8");
}

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
	process.env[ENV_VAR_NAME] = RESOLVED_ENV_SENTINEL;
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
	delete process.env[ENV_VAR_NAME];
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ModelConfig secrecy guard", () => {
	it("loads a legacy provider-only models.json unchanged, including literal and reference apiKey values", async () => {
		const path = join(sharedTempDir, "unchanged.json");
		writeModelsJson(path);

		const config = await ModelConfig.load(path);

		expect(config.getError()).toBeUndefined();
		expect([...config.getProviderIds()].sort()).toEqual(["command", "env", "literal"]);
		// The loader is credential-blind: it stores the raw reference verbatim and never
		// resolves $ENV or "!command" values itself.
		expect(config.getProvider("literal")?.apiKey).toBe(LITERAL_SENTINEL);
		expect(config.getProvider("env")?.apiKey).toBe(`$${ENV_VAR_NAME}`);
		expect(config.getProvider("command")?.apiKey).toBe(`!echo ${COMMAND_SENTINEL}`);
	});

	it("never writes to the models.json file it loads", async () => {
		const path = join(sharedTempDir, "read-only.json");
		writeModelsJson(path);
		const before = readFileSync(path, "utf-8");
		const statBefore = statSync(path);

		await ModelConfig.load(path);
		// A second load exercises any lazily-initialized write path too.
		await ModelConfig.load(path);

		const after = readFileSync(path, "utf-8");
		const statAfter = statSync(path);
		expect(after).toBe(before);
		expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
	});

	it("never logs a literal or resolved secret while loading", async () => {
		const path = join(sharedTempDir, "no-log.json");
		writeModelsJson(path);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await ModelConfig.load(path);

		for (const spy of [logSpy, warnSpy, errorSpy]) {
			for (const call of spy.mock.calls) {
				const text = call.map((arg) => String(arg)).join(" ");
				expect(text).not.toContain(LITERAL_SENTINEL);
				expect(text).not.toContain(RESOLVED_ENV_SENTINEL);
				expect(text).not.toContain(COMMAND_SENTINEL);
			}
		}
	});

	it("never resolves or copies a resolved environment secret into loader-generated output", async () => {
		const path = join(sharedTempDir, "no-copy.json");
		writeModelsJson(path);

		const config = await ModelConfig.load(path);

		const serialized = JSON.stringify({
			ids: config.getProviderIds(),
			providers: config.getProviderIds().map((id) => config.getProvider(id)),
			error: config.getError(),
		});
		// The resolved env value must never appear: the loader stores the raw "$VAR"
		// reference and never calls resolveConfigValue itself.
		expect(serialized).not.toContain(RESOLVED_ENV_SENTINEL);
		// The command reference is stored as an inert, unexecuted "!..." string; its
		// argument text is expected to appear verbatim, unlike a resolved value.
		expect(serialized).toContain(`!echo ${COMMAND_SENTINEL}`);
		// The literal value is expected to remain readable (the compatibility path).
		expect(serialized).toContain(LITERAL_SENTINEL);
	});

	it("reports a schema error without ever writing a file, for a malformed models.json", async () => {
		const path = join(sharedTempDir, "malformed.json");
		writeFileSync(path, JSON.stringify({ providers: { bad: { apiKey: 12345 } } }), "utf-8");
		const before = readFileSync(path, "utf-8");

		const config = await ModelConfig.load(path);

		expect(config.getError()).toBeDefined();
		expect(config.getProviderIds()).toEqual([]);
		expect(readFileSync(path, "utf-8")).toBe(before);
	});
});
