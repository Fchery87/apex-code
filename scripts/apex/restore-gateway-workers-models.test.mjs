import assert from "node:assert/strict";
import test from "node:test";
import { mirrorWorkersAiIntoGateway } from "./restore-gateway-workers-models.mjs";

const workersAiModel = (id, overrides = {}) => ({
	id,
	name: `Name ${id}`,
	api: "openai-completions",
	provider: "cloudflare-workers-ai",
	baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
	compat: { sendSessionAffinityHeaders: true, supportsStore: false },
	...overrides,
});

const gatewayModel = (id, api) => ({
	id,
	name: `Name ${id}`,
	api,
	provider: "cloudflare-ai-gateway",
	baseUrl: "https://gateway.ai.cloudflare.com/v1/a/b/anthropic",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
});

test("restores an openai-completions group when models.dev drops the gateway passthroughs", () => {
	const { catalog, added } = mirrorWorkersAiIntoGateway(
		{ "anthropic-messages": { "claude-fable-5": gatewayModel("claude-fable-5", "anthropic-messages") } },
		{ "openai-completions": { "@cf/meta/llama-4": workersAiModel("@cf/meta/llama-4") } },
	);

	assert.deepEqual(added, ["workers-ai/@cf/meta/llama-4"]);
	assert.deepEqual(Object.keys(catalog), ["anthropic-messages", "openai-completions"]);

	const mirrored = catalog["openai-completions"]["workers-ai/@cf/meta/llama-4"];
	assert.equal(mirrored.id, "workers-ai/@cf/meta/llama-4");
	assert.equal(mirrored.provider, "cloudflare-ai-gateway");
	assert.equal(mirrored.baseUrl, "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat");
	assert.deepEqual(mirrored.compat, { sendSessionAffinityHeaders: true });
	assert.equal(mirrored.contextWindow, 4096);
});

test("carries the thinking level map across only when the source model has one", () => {
	const thinkingLevelMap = { minimal: null, low: null, medium: null, high: "high", max: "max" };
	const { catalog } = mirrorWorkersAiIntoGateway(
		{},
		{
			"openai-completions": {
				"@cf/a": workersAiModel("@cf/a", { reasoning: true, thinkingLevelMap }),
				"@cf/b": workersAiModel("@cf/b"),
			},
		},
	);

	const group = catalog["openai-completions"];
	assert.deepEqual(group["workers-ai/@cf/a"].thinkingLevelMap, thinkingLevelMap);
	assert.ok(!("thinkingLevelMap" in group["workers-ai/@cf/b"]));
	assert.equal(group["workers-ai/@cf/a"].reasoning, true);
});

test("leaves a gateway passthrough models.dev still lists untouched", () => {
	const listed = gatewayModel("workers-ai/@cf/meta/llama-4", "openai-completions");
	const { catalog, added } = mirrorWorkersAiIntoGateway(
		{ "openai-completions": { "workers-ai/@cf/meta/llama-4": listed } },
		{ "openai-completions": { "@cf/meta/llama-4": workersAiModel("@cf/meta/llama-4") } },
	);

	assert.deepEqual(added, []);
	assert.deepEqual(catalog["openai-completions"]["workers-ai/@cf/meta/llama-4"], listed);
});

test("is idempotent, so a second build does not restate the catalog", () => {
	const workersAi = { "openai-completions": { "@cf/meta/llama-4": workersAiModel("@cf/meta/llama-4") } };
	const once = mirrorWorkersAiIntoGateway({}, workersAi);
	const twice = mirrorWorkersAiIntoGateway(once.catalog, workersAi);

	assert.deepEqual(twice.added, []);
	assert.equal(JSON.stringify(twice.catalog), JSON.stringify(once.catalog));
});

test("groups and sorts the way the generator serializes catalogs", () => {
	const { catalog } = mirrorWorkersAiIntoGateway(
		{ "openai-responses": { "gpt-6": gatewayModel("gpt-6", "openai-responses") } },
		{
			"openai-completions": {
				"@cf/z": workersAiModel("@cf/z"),
				"@cf/a": workersAiModel("@cf/a"),
			},
		},
	);

	assert.deepEqual(Object.keys(catalog), ["openai-completions", "openai-responses"]);
	assert.deepEqual(Object.keys(catalog["openai-completions"]), ["workers-ai/@cf/a", "workers-ai/@cf/z"]);
});
