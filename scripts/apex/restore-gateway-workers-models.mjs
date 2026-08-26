#!/usr/bin/env node
/**
 * Restore the Workers AI passthroughs in the generated Cloudflare AI Gateway catalog.
 *
 * models.dev stopped listing `workers-ai/*` under the `cloudflare-ai-gateway`
 * provider. That catalog is generated at build time and its API grouping is what
 * `createProvider` infers `TApi` from, so the disappearance narrowed the inferred
 * union to `"anthropic-messages" | "openai-responses"` and upstream's own frozen
 * source stopped compiling:
 *
 *   src/providers/cloudflare-ai-gateway.ts(19,4): error TS2353: Object literal may
 *   only specify known properties, and '"openai-completions"' does not exist in
 *   type 'Partial<Record<"anthropic-messages" | "openai-responses", ProviderStreams>>'
 *
 * No commit in this repository caused it and none can fix it here: the failing file
 * is inside `packages/ai`, which ADR 0001 freezes byte-identical to `.upstream-tag`.
 * Upstream fixed it in e8c632ef6 ("fix(ai): cloudflare gateway type, include
 * workers") by mirroring the Workers AI catalog under the documented `workers-ai/`
 * prefix, because the gateway /compat endpoint routes to those models whether or not
 * models.dev lists them. That commit is unreleased, so no tag carries it and no
 * pin bump can take it.
 *
 * This runs the same mirroring above the boundary, against the generated data rather
 * than inside the frozen generator, and rewrites the data manifest to match.
 *
 * DELETE THIS once `.upstream-tag` names a release containing e8c632ef6. From then on
 * the frozen generator emits these entries itself and every model here is skipped as
 * already present, so the script becomes a no-op that still costs a build step.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../../packages/ai/src/api/cloudflare.ts";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	readModelDataStructure,
	validateModelDataDirectory,
} from "../../packages/ai/scripts/model-data.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AI_PACKAGE_ROOT = join(REPO_ROOT, "packages/ai");
const GATEWAY_PROVIDER_ID = "cloudflare-ai-gateway";
const WORKERS_AI_PROVIDER_ID = "cloudflare-workers-ai";
const MIRRORED_API = "openai-completions";

/** The generator writes compact JSON with a trailing newline; manifest hashes cover the bytes. */
const serialize = (value) => `${JSON.stringify(value)}\n`;

/** Regroup a flat id→model map the way the generator does: model ids sorted, then split by sorted api. */
function groupByApi(models) {
	const grouped = {};
	for (const api of Array.from(new Set(Object.values(models).map((model) => model.api))).sort()) {
		grouped[api] = {};
	}
	for (const modelId of Object.keys(models).sort()) {
		const model = models[modelId];
		grouped[model.api][modelId] = model;
	}
	return grouped;
}

function flatten(catalog) {
	const models = {};
	for (const group of Object.values(catalog)) {
		for (const [modelId, model] of Object.entries(group)) models[modelId] = model;
	}
	return models;
}

/**
 * Mirror of the `cloudflare-workers-ai` block upstream added to generate-models.ts in
 * e8c632ef6. Field-for-field: the gateway entry keeps the source model's economics and
 * limits, takes the /compat base URL, and carries only session affinity in `compat`.
 */
export function mirrorWorkersAiIntoGateway(gatewayCatalog, workersAiCatalog) {
	const gatewayModels = flatten(gatewayCatalog);
	const added = [];

	for (const [modelId, model] of Object.entries(flatten(workersAiCatalog))) {
		const id = `workers-ai/${modelId}`;
		if (gatewayModels[id]) continue;
		gatewayModels[id] = {
			id,
			name: model.name || id,
			api: MIRRORED_API,
			provider: GATEWAY_PROVIDER_ID,
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			reasoning: model.reasoning === true,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			compat: { sendSessionAffinityHeaders: true },
			...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		};
		added.push(id);
	}

	return { catalog: groupByApi(gatewayModels), added };
}

export function restoreGatewayWorkersModels(packageRoot = AI_PACKAGE_ROOT) {
	const dataDir = join(packageRoot, "src/providers/data");
	const readCatalog = (providerId) => JSON.parse(readFileSync(join(dataDir, `${providerId}.json`), "utf8"));

	const { catalog, added } = mirrorWorkersAiIntoGateway(
		readCatalog(GATEWAY_PROVIDER_ID),
		readCatalog(WORKERS_AI_PROVIDER_ID),
	);

	if (added.length > 0) writeFileSync(join(dataDir, `${GATEWAY_PROVIDER_ID}.json`), serialize(catalog));

	// Read after the write: the manifest hashes the bytes now on disk, not the ones we replaced.
	const structure = readModelDataStructure(packageRoot);
	if (added.length > 0) writeManifest(structure, dataDir);
	validateModelDataDirectory(structure, dataDir);
	return added;
}

function writeManifest(structure, dataDir) {
	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	const fileContents = Object.fromEntries(
		Object.keys(structure).map((providerId) => {
			const filename = `${providerId}.json`;
			return [filename, readFileSync(join(dataDir, filename), "utf8")];
		}),
	);
	// Keep the generator's timestamp: the catalog was fetched then, this only regroups it.
	const generatedAt = JSON.parse(readFileSync(manifestPath, "utf8")).generatedAt ?? new Date().toISOString();
	writeFileSync(manifestPath, serialize(createModelDataManifest(structure, fileContents, generatedAt)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const added = restoreGatewayWorkersModels();
	console.log(
		added.length === 0
			? `${GATEWAY_PROVIDER_ID}: Workers AI passthroughs already present, nothing to restore`
			: `${GATEWAY_PROVIDER_ID}: restored ${added.length} Workers AI passthrough(s) under ${MIRRORED_API}`,
	);
}
