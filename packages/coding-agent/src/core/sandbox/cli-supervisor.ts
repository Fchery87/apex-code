import { buildSandboxedCliLaunch } from "./cli-launch.ts";
import { createLinuxSandboxBackend } from "./linux-backend.ts";
import { createSandboxPolicy } from "./policy.ts";
import { createSandboxSupervisor, type SandboxBackend } from "./supervisor.ts";

export interface CliSandboxDependencies {
	createBackend: () => SandboxBackend;
	stderr: { write(message: string): boolean };
}

const defaultDependencies: CliSandboxDependencies = {
	createBackend: createLinuxSandboxBackend,
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
	readOnlyPaths?: readonly string[];
	dependencies?: Partial<CliSandboxDependencies>;
}): Promise<number> {
	const dependencies = { ...defaultDependencies, ...options.dependencies };
	const policyResult = createSandboxPolicy({ workspace: options.workspace });
	if (policyResult.kind === "invalid") {
		dependencies.stderr.write(`Error: OS sandbox is not enforcing this agent session: ${policyResult.reason}\n`);
		return 1;
	}
	const backend = dependencies.createBackend();
	const supervisor = createSandboxSupervisor({ backend, policy: policyResult.policy });
	const launch = buildSandboxedCliLaunch({
		workspace: policyResult.policy.workspace,
		command: options.command,
		args: options.args,
		environment: options.environment,
		readOnlyPaths: options.readOnlyPaths,
	});
	try {
		return await supervisor.launch(launch);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Failed to start OS sandbox.";
		dependencies.stderr.write(`Error: ${message}\n`);
		return 1;
	} finally {
		await supervisor.close();
	}
}
