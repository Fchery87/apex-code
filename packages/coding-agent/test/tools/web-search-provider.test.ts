import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigValueCache } from "../../src/core/resolve-config-value.ts";
import type { WebSearchSettings } from "../../src/core/settings-manager.ts";
import { createAllToolDefinitions, createAllTools } from "../../src/core/tools/index.ts";
import {
	createDeferredWebSearchOperations,
	resolveWebSearchHost,
	resolveWebSearchOperations,
	unconfiguredWebSearchMessage,
} from "../../src/core/web-search-provider.ts";

// `resolveConfigValue` falls back to the real `process.env` when the supplied env
// lacks a name, so a host key would otherwise make the unconfigured cases pass for
// the wrong reason.
let savedKey: string | undefined;

beforeEach(() => {
	savedKey = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
	clearConfigValueCache();
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = savedKey;
	clearConfigValueCache();
});

describe("web_search backend resolution", () => {
	it("stays unconfigured when no credential resolves, leaving the tool's loud default in place", () => {
		expect(resolveWebSearchOperations(undefined, {})).toBeUndefined();
		expect(resolveWebSearchOperations({ provider: "exa" }, {})).toBeUndefined();
	});

	it("configures Exa from EXA_API_KEY with no settings at all", () => {
		expect(resolveWebSearchOperations(undefined, { EXA_API_KEY: "env-key" })).toBeDefined();
	});

	it("honors an explicit config-value reference in settings", () => {
		const settings: WebSearchSettings = { provider: "exa", apiKey: "$CUSTOM_EXA_KEY" };
		expect(resolveWebSearchOperations(settings, {})).toBeUndefined();
		expect(resolveWebSearchOperations(settings, { CUSTOM_EXA_KEY: "custom" })).toBeDefined();
	});

	it("treats a blank key as unconfigured rather than sending an empty header", () => {
		expect(resolveWebSearchOperations(undefined, { EXA_API_KEY: "   " })).toBeUndefined();
	});
});

describe("web_search sandbox host", () => {
	it("names no host until a credential is configured", () => {
		expect(resolveWebSearchHost(undefined, {})).toBeUndefined();
	});

	it("names the backend's host once a credential is configured", () => {
		expect(resolveWebSearchHost(undefined, { EXA_API_KEY: "env-key" })).toBe("api.exa.ai");
	});

	it("recognizes a command reference without executing it", () => {
		// A shell spawn here would run on every supervisor launch. `false` exits
		// non-zero, so a host coming back proves the command was never executed.
		expect(resolveWebSearchHost({ provider: "exa", apiKey: "!false" }, {})).toBe("api.exa.ai");
	});
});

describe("web_search registry wiring", () => {
	it("registers web_search whether or not a backend is configured, so the prompt surface never shifts", () => {
		expect(Object.keys(createAllToolDefinitions("/workspace"))).toContain("web_search");
		expect(
			Object.keys(
				createAllToolDefinitions("/workspace", { web_search: { operations: { search: async () => [] } } }),
			),
		).toContain("web_search");
	});

	it("routes calls through injected operations when the session supplies a backend", async () => {
		const queries: string[] = [];
		const tools = createAllTools("/workspace", {
			web_search: {
				operations: {
					search: async (query) => {
						queries.push(query);
						return [{ title: "T", url: "https://example.com/t", snippet: "s" }];
					},
				},
			},
		});

		const result = await tools.web_search.execute("call-1", { query: "wired" });

		expect(queries).toEqual(["wired"]);
		expect(result.content.find((block) => block.type === "text")?.text).toContain("https://example.com/t");
	});
});

/** Write an auth.json holding one credential, and return its path. */
function authFileWith(credential: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-websearch-auth-"));
	authDirs.push(dir);
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({ exa: credential }, null, 2));
	return path;
}

const authDirs: string[] = [];

afterEach(() => {
	while (authDirs.length > 0) rmSync(authDirs.pop() as string, { recursive: true, force: true });
});

describe("web_search stored credential", () => {
	it("uses a key stored in auth.json when settings name none", () => {
		const authPath = authFileWith({ type: "api_key", key: "stored-key" });
		expect(resolveWebSearchOperations(undefined, {}, authPath)).toBeDefined();
	});

	it("prefers a stored key over the ambient environment variable", () => {
		// A user who just typed a key into the settings dialog expects it to win over
		// a stale export they forgot about.
		const authPath = authFileWith({ type: "api_key", key: "stored-key" });
		expect(resolveWebSearchHost(undefined, { EXA_API_KEY: "env-key" }, authPath)).toBe("api.exa.ai");
		expect(resolveWebSearchOperations(undefined, { EXA_API_KEY: "env-key" }, authPath)).toBeDefined();
	});

	it("lets an explicit settings reference override a stored key", () => {
		const authPath = authFileWith({ type: "api_key", key: "stored-key" });
		const settings = { provider: "exa", apiKey: "$ONLY_HERE" } as const;
		expect(resolveWebSearchOperations(settings, {}, authPath)).toBeUndefined();
		expect(resolveWebSearchOperations(settings, { ONLY_HERE: "x" }, authPath)).toBeDefined();
	});

	it("resolves a command reference stored by the dialog", () => {
		const authPath = authFileWith({ type: "api_key", key: "!printf resolved-key" });
		expect(resolveWebSearchOperations(undefined, {}, authPath)).toBeDefined();
	});

	it("ignores a stored credential that is not an API key", () => {
		const authPath = authFileWith({ type: "oauth", access: "a", refresh: "r", expires: 0 });
		expect(resolveWebSearchOperations(undefined, {}, authPath)).toBeUndefined();
		expect(resolveWebSearchHost(undefined, {}, authPath)).toBeUndefined();
	});

	it("falls back to the environment when auth.json holds nothing for the backend", () => {
		const authPath = join(mkdtempSync(join(tmpdir(), "apex-websearch-empty-")), "auth.json");
		writeFileSync(authPath, "{}");
		expect(resolveWebSearchOperations(undefined, {}, authPath)).toBeUndefined();
		expect(resolveWebSearchOperations(undefined, { EXA_API_KEY: "env-key" }, authPath)).toBeDefined();
	});
});

describe("web_search deferred resolution", () => {
	it("picks up a credential saved after the session was built, with no restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-websearch-deferred-"));
		authDirs.push(dir);
		const authPath = join(dir, "auth.json");
		writeFileSync(authPath, "{}");

		// Exactly what the session holds: built once, before any key exists.
		const operations = createDeferredWebSearchOperations(() => undefined, authPath);
		await expect(operations.search("before")).rejects.toThrow(/no API key configured/i);

		writeFileSync(authPath, JSON.stringify({ exa: { type: "api_key", key: "saved-later" } }));

		// Reaches the adapter now, so it fails on transport rather than on configuration.
		await expect(operations.search("after")).rejects.not.toThrow(/no API key configured/i);
	});

	it("names both the environment variable and the settings path when unconfigured", () => {
		const message = unconfiguredWebSearchMessage();
		expect(message).toContain("EXA_API_KEY");
		expect(message).toContain("/settings");
		// The old text told a user to pass a TypeScript option.
		expect(message).not.toContain("WebSearchToolOptions");
	});
});
