import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { HostToolBinary } from "../../utils/tools-manager.ts";
import { SettingsManager } from "../settings-manager.ts";
import { resolveDefaultAllowedHosts } from "./default-hosts.ts";
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

/**
 * Read supervisor policy only from global settings; project settings are untrusted here.
 *
 * The built-in provider hosts are added unless explicitly refused, because a deny-all
 * default made a fresh install unable to reach any model while giving the user no way to
 * learn which host to permit. Configured hosts are additive on top, and
 * `allowDefaultHosts: false` restores the strict behaviour for anyone who wants it.
 */
export function resolveSupervisorAllowedHosts(cwd: string, agentDir: string): readonly string[] | undefined {
	const network = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getNetworkSettings();
	const configured = network?.allowedHosts ?? [];
	if (network?.allowDefaultHosts === false) return configured;
	return [...new Set([...resolveDefaultAllowedHosts(), ...configured])];
}

/**
 * The host's two user-scope skill roots, each present only when it exists on the
 * host. Kept as two named slots rather than one list because
 * `core/package-manager.ts` discovers them in different modes -- root `.md` files
 * count as skills under `agentSkills` ("pi" mode) and are ignored under
 * `agentsHomeSkills` ("agents" mode), per `docs/skills.md` -- and a flat list of 0-2
 * paths cannot tell the child which root a lone survivor was.
 */
export interface HostSkillPaths {
	/** Host `<agentDir>/skills`. */
	readonly agentSkills?: string;
	/** Host `<home>/.agents/skills`. */
	readonly agentsHomeSkills?: string;
}

/** A candidate skill root that exists but was excluded, and why. */
export interface HostSkillPathRefusal {
	readonly root: keyof HostSkillPaths;
	readonly path: string;
	readonly reason: string;
}

export interface ResolvedHostSkillPaths {
	readonly paths: HostSkillPaths;
	readonly refusals: readonly HostSkillPathRefusal[];
}

/**
 * True when `candidate` is the host home directory itself, or an ancestor of it.
 * Both paths must already be resolved (`realpathSync`), so a symlink can't disguise
 * either side. Mounting such a candidate read-only would re-expose the entire home
 * tree the sandbox's `--tmpfs /home` (Linux) / `(deny file-read* USER_HOME)` (macOS)
 * deliberately hides -- SSH keys, cloud credentials, other projects -- not just a
 * skills subtree.
 */
function isHomeOrAncestorOfHome(candidate: string, home: string): boolean {
	if (candidate === home) return true;
	const prefix = candidate.endsWith(sep) ? candidate : candidate + sep;
	return home.startsWith(prefix);
}

/** Resolve one candidate root: absent, refused (symlinked onto the host home), or usable. */
function resolveHostSkillRoot(
	root: keyof HostSkillPaths,
	candidate: string,
	homeDir: string,
): { path?: string; refusal?: HostSkillPathRefusal } {
	if (!existsSync(candidate)) return {};
	let realCandidate: string;
	let realHome: string;
	try {
		realCandidate = realpathSync(candidate);
		realHome = realpathSync(homeDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { refusal: { root, path: candidate, reason: `could not resolve real path: ${message}` } };
	}
	if (isHomeOrAncestorOfHome(realCandidate, realHome)) {
		return {
			refusal: {
				root,
				path: candidate,
				reason: "resolves to the host home directory or an ancestor of it",
			},
		};
	}
	return { path: candidate };
}

/**
 * Resolve the host's user-scope skill directories, before the sandbox exists to hide
 * them. Read only from the runtime environment and the host agent directory --
 * never from project files -- matching ADR 0016's rule that supervisor policy is
 * trust-first. Mirrors `core/package-manager.ts`'s own user-scope roots so the two
 * sides agree on where a skill lives. A candidate that resolves (directly or via a
 * symlink) onto the host home or an ancestor of it is refused rather than mounted --
 * see `isHomeOrAncestorOfHome` -- and reported so the caller can surface a startup
 * diagnostic instead of silently mounting or silently skipping it.
 */
export function resolveHostSkillPaths(agentDir: string, homeDir: string): ResolvedHostSkillPaths {
	const agentSkills = resolveHostSkillRoot("agentSkills", join(agentDir, "skills"), homeDir);
	const agentsHomeSkills = resolveHostSkillRoot("agentsHomeSkills", join(homeDir, ".agents", "skills"), homeDir);
	return {
		paths: {
			...(agentSkills.path ? { agentSkills: agentSkills.path } : {}),
			...(agentsHomeSkills.path ? { agentsHomeSkills: agentsHomeSkills.path } : {}),
		},
		refusals: [agentSkills.refusal, agentsHomeSkills.refusal].filter(
			(refusal): refusal is HostSkillPathRefusal => refusal !== undefined,
		),
	};
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
 * Drop empty files left in the child's tools directory by a previous launch.
 *
 * A projected tool is bind-mounted over a file there, and bwrap materialises that
 * mountpoint as an empty file on the host which outlives the namespace. If the host
 * tool later disappears, nothing is projected over the stub and the child would
 * otherwise find a 0-byte file where its binary should be. A real downloaded binary
 * is never empty, so size is a safe discriminator.
 */
function clearStaleToolMountpoints(toolsDirectory: string): void {
	for (const entry of readdirSync(toolsDirectory, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const entryPath = join(toolsDirectory, entry.name);
		if (statSync(entryPath).size === 0) {
			rmSync(entryPath, { force: true });
		}
	}
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
	toolBinaries?: readonly HostToolBinary[];
	/**
	 * Host user-scope skill directories, pre-filtered by the caller to those that
	 * exist and pass the host-home escape check (SKILL.4). Mounted read-only at their
	 * original host location -- Seatbelt cannot remap a path, so this must hold for
	 * both backends -- and named to the child via `APEX_CODE_SKILL_PATH_*` so its
	 * discovery can find them under the sandbox's own repointed `HOME`/agent dir.
	 */
	skillPaths?: HostSkillPaths;
}): SandboxedCliLaunch {
	const stateDirectory = join(options.workspace, ".apex-code", "sandbox-state");
	const agentDirectory = join(options.workspace, ".apex-code", "sandbox-agent");
	const sessionDirectory = join(options.workspace, ".apex-code", "sandbox-sessions");
	// Mirrors getBinDir() as the child will compute it from APEX_CODE_CODING_AGENT_DIR,
	// so a projected tool lands exactly where the child's own lookup already checks.
	const toolsDirectory = join(agentDirectory, "bin");
	const xdgDirectories = {
		XDG_CONFIG_HOME: join(stateDirectory, "config"),
		XDG_CACHE_HOME: join(stateDirectory, "cache"),
		XDG_DATA_HOME: join(stateDirectory, "data"),
		XDG_STATE_HOME: join(stateDirectory, "state"),
	};
	for (const directory of [
		stateDirectory,
		agentDirectory,
		sessionDirectory,
		toolsDirectory,
		...Object.values(xdgDirectories),
	]) {
		mkdirSync(directory, { recursive: true });
	}
	clearStaleToolMountpoints(toolsDirectory);
	const childEnvironment = buildChildEnvironment(options.environment);
	const { agentSkills, agentsHomeSkills } = options.skillPaths ?? {};
	const skillMountPaths = [agentSkills, agentsHomeSkills].filter((path): path is string => path !== undefined);
	const readOnlyPaths = [...(options.readOnlyPaths ?? []), ...skillMountPaths];
	const readOnlyFiles = options.authPath ? [options.authPath] : [];
	const readOnlyBinaries = (options.toolBinaries ?? []).map((binary) => ({
		source: binary.path,
		destination: join(toolsDirectory, binary.name),
	}));
	return {
		command: options.command,
		args: [...options.args],
		policy: { workspace: options.workspace, allowedHosts: options.allowedHosts ?? [] },
		readOnlyPaths,
		readOnlyFiles,
		readOnlyBinaries,
		environment: {
			...childEnvironment,
			...(options.authPath ? { APEX_CODE_AUTH_PATH: options.authPath } : {}),
			// After childEnvironment: these come only from the supervisor's own
			// resolution, never from the invoking shell, so their value always wins over
			// anything of the same name that childEnvironment's allowlist let through.
			...(agentSkills ? { APEX_CODE_SKILL_PATH_AGENT: agentSkills } : {}),
			...(agentsHomeSkills ? { APEX_CODE_SKILL_PATH_AGENTS_HOME: agentsHomeSkills } : {}),
			APEX_CODE_CODING_AGENT_DIR: agentDirectory,
			APEX_CODE_CODING_AGENT_SESSION_DIR: sessionDirectory,
			HOME: stateDirectory,
			TMPDIR: stateDirectory,
			...xdgDirectories,
		},
	};
}
