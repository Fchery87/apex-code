import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager } from "../settings-manager.ts";
import type { SandboxLaunch } from "./supervisor.ts";

const NON_SESSION_COMMANDS = new Set(["auth", "config", "install", "remove", "uninstall", "update", "list"]);
const METADATA_FLAGS = new Set(["--version", "-v", "--export", "--list-models"]);

/**
 * OS containment is the normal startup path for every command that can construct an
 * agent session. Commands that only inspect or maintain host configuration do not
 * create a runtime and therefore remain outside this child boundary.
 */
export function requiresSandboxedChild(args: readonly string[]): boolean {
	if (NON_SESSION_COMMANDS.has(args[0] ?? "")) return false;
	if (args.some((argument) => METADATA_FLAGS.has(argument))) return false;
	if (args.includes("--help") || args.includes("-h")) return false;
	return true;
}

export interface SandboxedCliLaunch extends SandboxLaunch {
	readonly environment: NodeJS.ProcessEnv;
}

/** Read supervisor policy only from global settings; project settings are untrusted here. */
export function resolveSupervisorAllowedHosts(cwd: string, agentDir: string): readonly string[] | undefined {
	return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getNetworkSettings()?.allowedHosts;
}

const SAFE_CHILD_ENVIRONMENT_KEYS = new Set([
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"TSX_TSCONFIG_PATH",
	"APEX_CODE_OFFLINE",
	"APEX_CODE_SKIP_VERSION_CHECK",
	"APEX_CODE_EXPERIMENTAL",
	"APEX_CODE_STARTUP_BENCHMARK",
	"APEX_CODE_TIMING",
	"APEX_CODE_CLEAR_ON_SHRINK",
	"APEX_CODE_HARDWARE_CURSOR",
	"APEX_CODE_MODEL_CATALOG_URL",
	"APEX_CODE_SHARE_VIEWER_URL",
	"VISUAL",
	"EDITOR",
]);

// Provider API keys are explicit credential inputs, unlike arbitrary ambient variables.
// Keep this list in sync with the documented provider environment-variable reference.
const SAFE_PROVIDER_CREDENTIAL_KEYS = new Set([
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANT_LING_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"BASETEN_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MOONSHOT_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_REGION",
]);

function buildChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(environment).filter(
			([key]) => SAFE_CHILD_ENVIRONMENT_KEYS.has(key) || SAFE_PROVIDER_CREDENTIAL_KEYS.has(key),
		),
	);
}

/**
 * Allocate agent-owned state under the sole writable workspace mount. The child does
 * not inherit a host home or a host session/config directory, preventing the sandbox
 * from presenting a write boundary while its own state quietly escapes it.
 */
export function buildSandboxedCliLaunch(options: {
	workspace: string;
	command: string;
	args: readonly string[];
	environment: NodeJS.ProcessEnv;
	allowedHosts?: readonly string[];
	readOnlyPaths?: readonly string[];
	authPath?: string;
}): SandboxedCliLaunch {
	const stateDirectory = join(options.workspace, ".apex-code", "sandbox-state");
	const agentDirectory = join(options.workspace, ".apex-code", "sandbox-agent");
	const sessionDirectory = join(options.workspace, ".apex-code", "sandbox-sessions");
	const xdgDirectories = {
		XDG_CONFIG_HOME: join(stateDirectory, "config"),
		XDG_CACHE_HOME: join(stateDirectory, "cache"),
		XDG_DATA_HOME: join(stateDirectory, "data"),
		XDG_STATE_HOME: join(stateDirectory, "state"),
	};
	for (const directory of [stateDirectory, agentDirectory, sessionDirectory, ...Object.values(xdgDirectories)]) {
		mkdirSync(directory, { recursive: true });
	}
	const childEnvironment = buildChildEnvironment(options.environment);
	const readOnlyPaths = [...(options.readOnlyPaths ?? [])];
	const readOnlyFiles = options.authPath ? [options.authPath] : [];
	return {
		command: options.command,
		args: [...options.args],
		policy: { workspace: options.workspace, allowedHosts: options.allowedHosts ?? [] },
		readOnlyPaths,
		readOnlyFiles,
		environment: {
			...childEnvironment,
			...(options.authPath ? { APEX_CODE_AUTH_PATH: options.authPath } : {}),
			APEX_CODE_CODING_AGENT_DIR: agentDirectory,
			APEX_CODE_CODING_AGENT_SESSION_DIR: sessionDirectory,
			HOME: stateDirectory,
			TMPDIR: stateDirectory,
			...xdgDirectories,
		},
	};
}
