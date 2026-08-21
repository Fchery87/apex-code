import type { HostToolBinary } from "../../utils/tools-manager.ts";
import { buildSandboxedCliLaunch, type HostSkillPaths } from "./cli-launch.ts";
import { createLinuxSandboxBackend } from "./linux-backend.ts";
import { createMacosSandboxBackend } from "./macos-backend.ts";
import { createSandboxPolicy } from "./policy.ts";
import { createSandboxSupervisor, type SandboxBackend } from "./supervisor.ts";
import { SandboxViolationStore } from "./violations.ts";

export interface CliSandboxDependencies {
	createBackend: (options: { violationStore: SandboxViolationStore }) => SandboxBackend;
	stderr: { write(message: string): boolean };
}

/** Routes to the platform adapter for the running OS; each adapter self-reports
 * `unavailable` on any other platform, so this only needs to pick the one whose
 * enforcement is actually reachable here. */
function createDefaultSandboxBackend(options: { violationStore: SandboxViolationStore }): SandboxBackend {
	if (process.platform === "darwin") return createMacosSandboxBackend(options);
	return createLinuxSandboxBackend(options);
}

const defaultDependencies: CliSandboxDependencies = {
	createBackend: createDefaultSandboxBackend,
	stderr: process.stderr,
};

/**
 * Start a normal CLI runtime beneath the whole-process boundary. The caller returns
 * the result directly so the outer process never continues into `main()` afterward.
 */
export async function launchSandboxedCli(options: {
	command: string;
	args: readonly string[];
	environment: NodeJS.ProcessEnv;
	workspace: string;
	allowedHosts?: readonly string[];
	readOnlyPaths?: readonly string[];
	authPath?: string;
	toolBinaries?: readonly HostToolBinary[];
	skillPaths?: HostSkillPaths;
	dependencies?: Partial<CliSandboxDependencies>;
}): Promise<number> {
	const dependencies = { ...defaultDependencies, ...options.dependencies };
	const policyResult = createSandboxPolicy({ workspace: options.workspace, allowedHosts: options.allowedHosts });
	if (policyResult.kind === "invalid") {
		dependencies.stderr.write(`Error: OS sandbox is not enforcing this agent session: ${policyResult.reason}\n`);
		return 1;
	}
	const violationStore = new SandboxViolationStore();
	const backend = dependencies.createBackend({ violationStore });
	const supervisor = createSandboxSupervisor({ backend, policy: policyResult.policy });
	const launch = buildSandboxedCliLaunch({
		workspace: policyResult.policy.workspace,
		command: options.command,
		args: options.args,
		environment: options.environment,
		allowedHosts: options.allowedHosts,
		readOnlyPaths: options.readOnlyPaths,
		authPath: options.authPath,
		toolBinaries: options.toolBinaries,
		skillPaths: options.skillPaths,
	});
	try {
		return await supervisor.launch(launch);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Failed to start OS sandbox.";
		dependencies.stderr.write(`Error: ${message}\n`);
		return 1;
	} finally {
		for (const violation of violationStore.list()) {
			dependencies.stderr.write(
				`Sandbox violation (${violation.kind}): ${violation.command} — ${violation.detail}\n`,
			);
		}
		await supervisor.close();
	}
}
