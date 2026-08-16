import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { resolveModelRoles } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const sharedTempDir = join(tmpdir(), `pi-model-roles-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeAll(() => {
	mkdirSync(sharedTempDir, { recursive: true });
});

afterAll(() => {
	if (existsSync(sharedTempDir)) rmSync(sharedTempDir, { recursive: true });
});

function writeModelsJson(name: string, content: unknown): string {
	const path = join(sharedTempDir, name);
	writeFileSync(path, JSON.stringify(content, null, 2), "utf-8");
	return path;
}

describe("ModelConfig role schema", () => {
	it("leaves a legacy file with no roles key unchanged", async () => {
		const path = writeModelsJson("legacy.json", { providers: {} });
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		expect(config.getRoles().size).toBe(0);
	});

	it("rejects an empty role chain at schema validation, not silently", async () => {
		const path = writeModelsJson("empty-chain.json", { providers: {}, roles: { bad: { models: [] } } });
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeDefined();
		expect(config.getRoles().size).toBe(0);
	});

	it("rejects a malformed (non-string) role reference at schema validation", async () => {
		const path = writeModelsJson("malformed.json", { providers: {}, roles: { bad: { models: [123] } } });
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeDefined();
	});
});

describe("resolveModelRoles (pure)", () => {
	function model(provider: string, id: string) {
		return {
			id,
			name: id,
			api: "openai-completions" as const,
			provider,
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
	}

	it("returns an empty result when no roles are configured", () => {
		const result = resolveModelRoles(undefined, [model("a", "x")]);
		expect(result.roles.size).toBe(0);
		expect(result.diagnostics).toEqual([]);
	});

	it("rejects (in full) a role with an empty chain", () => {
		const result = resolveModelRoles(new Map([["empty", []]]), [model("a", "x")]);
		expect(result.roles.has("empty")).toBe(false);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "empty-chain", roleName: "empty" })]);
	});

	it("rejects (in full) a role referencing an unknown model, without casting or falling back", () => {
		const result = resolveModelRoles(new Map([["ghost", ["a/does-not-exist"]]]), [model("a", "x")]);
		expect(result.roles.has("ghost")).toBe(false);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: "unknown-model", roleName: "ghost", reference: "a/does-not-exist" }),
		]);
	});

	it("rejects (in full) a role listing the same resolved model twice", () => {
		const result = resolveModelRoles(new Map([["dup", ["a/x", "a/x"]]]), [model("a", "x")]);
		expect(result.roles.has("dup")).toBe(false);
		expect(result.diagnostics).toEqual([expect.objectContaining({ code: "duplicate-candidate", roleName: "dup" })]);
	});

	it("resolves a valid role to ordered Model objects", () => {
		const result = resolveModelRoles(new Map([["default", ["a/y", "a/x"]]]), [model("a", "x"), model("a", "y")]);
		expect(result.diagnostics).toEqual([]);
		expect(result.roles.get("default")?.map((m) => m.id)).toEqual(["y", "x"]);
	});
});

describe("ModelRuntime.resolveModelRoles", () => {
	it("resolves default/plan/tiny/designer plus a custom role to distinct models from one config", async () => {
		const providerId = "role-runtime";
		const faux = fauxProvider({
			provider: providerId,
			models: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }, { id: "model-d" }],
		});
		const path = writeModelsJson("distinct-roles.json", {
			providers: {},
			roles: {
				default: { models: [`${providerId}/model-a`] },
				plan: { models: [`${providerId}/model-b`] },
				tiny: { models: [`${providerId}/model-c`] },
				designer: { models: [`${providerId}/model-d`] },
				"my-custom-role": { models: [`${providerId}/model-a`, `${providerId}/model-b`] },
			},
		});

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: path,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		const { roles, diagnostics } = runtime.resolveModelRoles();
		expect(diagnostics).toEqual([]);
		expect(roles.get("default")?.map((m) => m.id)).toEqual(["model-a"]);
		expect(roles.get("plan")?.map((m) => m.id)).toEqual(["model-b"]);
		expect(roles.get("tiny")?.map((m) => m.id)).toEqual(["model-c"]);
		expect(roles.get("designer")?.map((m) => m.id)).toEqual(["model-d"]);
		expect(roles.get("my-custom-role")?.map((m) => m.id)).toEqual(["model-a", "model-b"]);
	});

	it("resolves to an empty role map for a legacy config, leaving it credential- and write-free", async () => {
		const path = writeModelsJson("legacy-runtime.json", { providers: {} });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: path,
			allowModelNetwork: false,
		});

		const { roles, diagnostics } = runtime.resolveModelRoles();
		expect(roles.size).toBe(0);
		expect(diagnostics).toEqual([]);
	});
});
