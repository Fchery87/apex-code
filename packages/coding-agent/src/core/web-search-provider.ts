import { readStoredCredential } from "./auth-storage.ts";
import { isConfigValueConfigured, resolveConfigValue } from "./resolve-config-value.ts";
import type { WebSearchSettings } from "./settings-manager.ts";
import type { WebSearchOperations } from "./tools/web-search.ts";
import { createExaWebSearchOperations, EXA_SEARCH_HOST } from "./tools/web-search-exa.ts";

export type WebSearchProviderId = "exa";

/**
 * One entry per backend `web_search` can speak to.
 *
 * A table rather than a branch because the swap is the point: the `web_search` tool
 * owns the contract and the permission grammar, the backend owns nothing but an HTTP
 * call, and adding the second backend should be a row here rather than a new code
 * path through the resolver.
 */
interface WebSearchProviderDefinition {
	/**
	 * Config-value reference used when settings name no key. Held as a reference,
	 * never a literal: a resolved key must never reach a file the settings loader
	 * writes back.
	 */
	readonly defaultApiKeyReference: string;
	/** Host the sandbox must allow before this backend can reach anything. */
	readonly host: string;
	/** `auth.json` key holding a credential saved from the settings panel. */
	readonly credentialId: string;
	create(options: {
		apiKey: string;
		endpoint?: string;
		numResults?: number;
		snippetMaxCharacters?: number;
	}): WebSearchOperations;
}

const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, WebSearchProviderDefinition> = {
	exa: {
		defaultApiKeyReference: "$EXA_API_KEY",
		host: EXA_SEARCH_HOST,
		credentialId: "exa",
		create: createExaWebSearchOperations,
	},
};

/**
 * Backend used when settings name none. `web_search` still reports itself
 * unconfigured unless this backend's key resolves, so the default selects which
 * credential is looked for, not whether the tool reaches the network.
 */
export const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProviderId = "exa";

function definitionFor(settings: WebSearchSettings | undefined): WebSearchProviderDefinition {
	return WEB_SEARCH_PROVIDERS[settings?.provider ?? DEFAULT_WEB_SEARCH_PROVIDER];
}

/** `auth.json` key the settings panel reads and writes for the selected backend. */
export function webSearchCredentialId(settings?: WebSearchSettings): string {
	return definitionFor(settings).credentialId;
}

/**
 * The reference stored by the settings panel, or undefined when nothing is saved.
 *
 * Whatever was saved stays a reference rather than being resolved here, so the one
 * resolution below covers a literal key, a `$VAR`, and a `!command` alike. An OAuth
 * credential under the same key is not an API key and is ignored rather than coerced.
 */
function storedApiKeyReference(settings: WebSearchSettings | undefined, authPath?: string): string | undefined {
	const credential = readStoredCredential(webSearchCredentialId(settings), authPath);
	if (credential?.type !== "api_key") return undefined;
	return credential.key?.trim() || undefined;
}

/**
 * Pick one reference, then resolve it once.
 *
 * Order is explicit configuration, then saved credential, then ambient environment.
 * A user who just typed a key into the settings dialog expects it to beat a stale
 * export they have forgotten about, and an explicit `webSearch.apiKey` in settings is
 * a direct instruction that should beat both.
 */
function apiKeyReferenceFor(settings: WebSearchSettings | undefined, authPath?: string): string {
	return (
		settings?.apiKey?.trim() ||
		storedApiKeyReference(settings, authPath) ||
		definitionFor(settings).defaultApiKeyReference
	);
}

/**
 * The host `web_search` needs on the sandbox allowlist, or undefined when no
 * credential is configured for the selected backend.
 *
 * Deliberately checks whether the key *reference* resolves rather than resolving it:
 * the supervisor calls this on every launch, and a `!command` reference would
 * otherwise spawn a shell before the child even starts. That check is an environment
 * lookup for a `$VAR` reference and free for a command reference.
 */
export function resolveWebSearchHost(
	settings: WebSearchSettings | undefined,
	env?: Record<string, string>,
	authPath?: string,
): string | undefined {
	const definition = definitionFor(settings);
	return isConfigValueConfigured(apiKeyReferenceFor(settings, authPath), env) ? definition.host : undefined;
}

/**
 * Build the configured `web_search` backend, or undefined when no credential
 * resolves.
 *
 * Undefined leaves the tool on its unconfigured operations, which throw a
 * model-readable "not configured" error. That is deliberately not the same thing as
 * hiding the tool: a session that silently lacks `web_search` cannot tell the model
 * why, and the throw names the missing piece.
 */
/**
 * What to tell the model, and through it the user, when nothing is configured.
 *
 * Named here rather than in `web-search.ts` because only this module knows which
 * backend was selected and therefore which credential to name. The audience is a
 * person who asked the agent to search something, so it names the two things they
 * can actually do, not the SDK option an embedder would pass.
 */
export function unconfiguredWebSearchMessage(settings?: WebSearchSettings): string {
	const definition = definitionFor(settings);
	const variable = definition.defaultApiKeyReference.replace(/^\$/, "");
	return `web_search has no API key configured. Set ${variable} in the environment, or run /settings and add a ${definition.credentialId} key.`;
}

/**
 * A `web_search` backend that resolves its credential on each call.
 *
 * The session builds its tool registry once, at construction, so operations captured
 * there would pin whatever was configured at startup. A key saved from the settings
 * panel would then appear to save and do nothing until restart, which is worse than
 * having no settings row at all. Resolving per call costs one small file read and
 * keeps `resolveConfigValue`'s cache for command references.
 */
export function createDeferredWebSearchOperations(
	readSettings: () => WebSearchSettings | undefined,
	authPath?: string,
): WebSearchOperations {
	return {
		async search(query, signal) {
			const settings = readSettings();
			const operations = resolveWebSearchOperations(settings, undefined, authPath);
			if (!operations) throw new Error(unconfiguredWebSearchMessage(settings));
			return operations.search(query, signal);
		},
	};
}

export function resolveWebSearchOperations(
	settings: WebSearchSettings | undefined,
	env?: Record<string, string>,
	authPath?: string,
): WebSearchOperations | undefined {
	const apiKey = resolveConfigValue(apiKeyReferenceFor(settings, authPath), env)?.trim();
	if (!apiKey) return undefined;
	return definitionFor(settings).create({
		apiKey,
		...(settings?.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
		...(settings?.numResults === undefined ? {} : { numResults: settings.numResults }),
		...(settings?.snippetMaxCharacters === undefined ? {} : { snippetMaxCharacters: settings.snippetMaxCharacters }),
	});
}
