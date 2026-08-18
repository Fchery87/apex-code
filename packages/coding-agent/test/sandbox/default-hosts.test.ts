import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_HOSTS, resolveDefaultAllowedHosts } from "../../src/core/sandbox/default-hosts.ts";
import { VERSION_CHECK_HOST } from "../../src/utils/version-check.ts";

describe("sandbox default allowed hosts", () => {
	// The constant exists so the supervisor does not pay ~190ms importing the provider
	// registry on every launch. This is the guard that keeps that copy honest: add or
	// remove a provider upstream and this fails until the constant is regenerated.
	it("matches the hosts the provider registry actually declares", () => {
		const hosts = new Set<string>();
		for (const provider of builtinProviderCatalog.builtinProviders()) {
			if (!provider.baseUrl) continue;
			try {
				hosts.add(new URL(provider.baseUrl).host);
			} catch {
				// A provider whose baseUrl is templated or malformed cannot be resolved
				// statically; it is intentionally absent from the default set.
			}
		}

		expect(DEFAULT_PROVIDER_HOSTS).toEqual([...hosts].sort());
	});

	it("covers the providers a new install is most likely to reach for", () => {
		expect(DEFAULT_PROVIDER_HOSTS).toContain("api.anthropic.com");
		expect(DEFAULT_PROVIDER_HOSTS).toContain("generativelanguage.googleapis.com");
		expect(DEFAULT_PROVIDER_HOSTS).toContain("api.openai.com");
	});

	// default-hosts.ts hardcodes this host instead of importing version-check.ts, whose
	// dependency chain costs the supervisor ~40ms per launch for one string. This is the
	// guard that keeps the copy in step with the URL actually requested.
	it("includes the update check host that version-check actually requests", () => {
		expect(resolveDefaultAllowedHosts()).toContain(VERSION_CHECK_HOST);
		expect(VERSION_CHECK_HOST).toBe("registry.npmjs.org");
	});

	it("lists every host exactly once", () => {
		const resolved = resolveDefaultAllowedHosts();
		expect(resolved.length).toBe(new Set(resolved).size);
	});
});
