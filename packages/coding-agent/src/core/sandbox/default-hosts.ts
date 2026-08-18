/**
 * Model-provider API hosts permitted by default inside the sandbox.
 *
 * The boundary shipped denying every host, which meant a fresh install could not reach
 * any model at all: the first request failed, and the user had no way to discover that
 * `generativelanguage.googleapis.com` was the missing entry — the endpoint is an
 * implementation detail of the provider, not something a user knows. Denying by default
 * only protects anyone if the working configuration is reachable without it.
 *
 * This list is a materialised copy of what `builtinProviders()` declares. It is not
 * derived at runtime because importing the provider registry costs roughly 190ms, and
 * the supervisor pays that on every launch before the child even starts.
 * `test/sandbox/default-hosts.test.ts` recomputes the set from the registry and fails if
 * this copy drifts, so adding a provider upstream cannot silently leave it unreachable.
 *
 * Providers whose `baseUrl` is absent or templated — Bedrock, Azure, Cloudflare, Vertex,
 * and the self-hosted ones — resolve their endpoint from account or environment
 * configuration the supervisor cannot see, so they are not here. Those still require an
 * explicit `network.allowedHosts` entry, and the refusal message now names the host.
 */
export const DEFAULT_PROVIDER_HOSTS: readonly string[] = [
	"ai-gateway.vercel.sh",
	"api.ant-ling.com",
	"api.anthropic.com",
	"api.cerebras.ai",
	"api.deepseek.com",
	"api.fireworks.ai",
	"api.groq.com",
	"api.individual.githubcopilot.com",
	"api.kimi.com",
	"api.minimax.io",
	"api.minimaxi.com",
	"api.mistral.ai",
	"api.moonshot.ai",
	"api.moonshot.cn",
	"api.openai.com",
	"api.together.ai",
	"api.x.ai",
	"api.xiaomimimo.com",
	"api.z.ai",
	"chatgpt.com",
	"generativelanguage.googleapis.com",
	"inference.baseten.co",
	"integrate.api.nvidia.com",
	"open.bigmodel.cn",
	"openrouter.ai",
	"router.huggingface.co",
	"token-plan-ams.xiaomimimo.com",
	"token-plan-cn.xiaomimimo.com",
	"token-plan-sgp.xiaomimimo.com",
	"token-plan.ap-southeast-1.maas.aliyuncs.com",
	"token-plan.cn-beijing.maas.aliyuncs.com",
];

/**
 * Host of Apex Code's own update check. Duplicated from `version-check.ts` rather than
 * imported: this module is loaded by the supervisor on every launch, and pulling in that
 * module's dependency chain costs roughly 40ms to obtain a single string.
 * `test/sandbox/default-hosts.test.ts` asserts the two agree.
 */
const UPDATE_CHECK_HOST = "registry.npmjs.org";

/**
 * Hosts allowed before any user configuration: every statically known model provider,
 * plus the update check, which is Apex Code's own outbound request and otherwise records
 * a policy violation on every single run.
 */
export function resolveDefaultAllowedHosts(): string[] {
	return [...new Set([...DEFAULT_PROVIDER_HOSTS, UPDATE_CHECK_HOST])];
}
