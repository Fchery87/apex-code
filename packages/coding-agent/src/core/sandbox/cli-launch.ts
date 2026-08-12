import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
 * Allocate agent-owned state under the sole writable workspace mount. The child does
 * not inherit a host home or a host session/config directory, preventing the sandbox
 * from presenting a write boundary while its own state quietly escapes it.
 */
export function buildSandboxedCliLaunch(options: {
	workspace: string;
	command: string;
	args: readonly string[];
	environment: NodeJS.ProcessEnv;
	readOnlyPaths?: readonly string[];
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
	return {
		command: options.command,
		args: [...options.args],
		policy: { workspace: options.workspace, allowedHosts: [] },
		readOnlyPaths: options.readOnlyPaths ?? [],
		environment: {
			...options.environment,
			APEX_CODE_CODING_AGENT_DIR: agentDirectory,
			APEX_CODE_CODING_AGENT_SESSION_DIR: sessionDirectory,
			HOME: stateDirectory,
			TMPDIR: stateDirectory,
			...xdgDirectories,
		},
	};
}
