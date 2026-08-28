import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../cli/args.ts";
import { reportConcurrentSessionRefusal } from "../../cli/concurrent-session.ts";
import type { HostToolBinary } from "../../utils/tools-manager.ts";
import { acquireSessionLease, readLiveSessionLeases } from "../session-lease.ts";
import { buildSandboxedCliLaunch, getSandboxSessionDirectory, type HostSkillPaths } from "./cli-launch.ts";
import { createProjectedGitConfig, resolveHostGitIdentity } from "./git-identity.ts";
import { createLinuxSandboxBackend } from "./linux-backend.ts";
import { createMacosSandboxBackend } from "./macos-backend.ts";
import { createSandboxPolicy } from "./policy.ts";
import { createCredentialProxy, resolveCredentialChannelPaths } from "./rpc/credential-proxy.ts";
import { gitCredentialHelperCommand } from "./rpc/git-credential-helper.ts";
import { createSandboxSupervisor, type SandboxBackend, type SandboxLaunch } from "./supervisor.ts";
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
	let credentialProxy: Awaited<ReturnType<typeof createCredentialProxy>> | undefined;
	let lease: ReturnType<typeof acquireSessionLease> | undefined;
	let projectedGitConfig: ReturnType<typeof createProjectedGitConfig> | undefined;
	try {
		const parsed = parseArgs(options.args);
		const wantsPersistentSession = !parsed.noSession && !parsed.help && parsed.listModels === undefined;
		const sessionDirectory = getSandboxSessionDirectory(policyResult.policy.workspace);
		if (wantsPersistentSession && !parsed.allowConcurrent) {
			const liveSessions = readLiveSessionLeases(sessionDirectory, policyResult.policy.workspace);
			if (liveSessions.length > 0) {
				reportConcurrentSessionRefusal(liveSessions, policyResult.policy.workspace);
				return 1;
			}
		}
		lease = wantsPersistentSession
			? acquireSessionLease(sessionDirectory, policyResult.policy.workspace, `supervisor-${process.pid}`)
			: undefined;

		// Open the host-owned credential channel only after startup checks that can
		// return early. AuthStorage creates a missing canonical file as 0600, so a
		// first-run credential writes get the same channel and read-only projection as later runs.
		let credentialChannel: SandboxLaunch["credentialChannel"];
		if (options.authPath && backend.status.kind === "enforced") {
			const paths = resolveCredentialChannelPaths();
			credentialProxy = await createCredentialProxy({
				authPath: options.authPath,
				violationStore,
				socketPath: paths.hostSocketPath,
				cleanupDirectory: paths.hostSocketDirectory,
			});
			credentialChannel = paths;
		}

		// Resolved here rather than in the caller because this function owns the teardown
		// that removes the directory again. The supervisor is unsandboxed, so the host home
		// is still visible at this point; inside the child it is not.
		const identity = resolveHostGitIdentity({ environment: options.environment });
		// The helper command is derived from the state directory rather than handed back by
		// the backend, because the config has to name it before any backend exists. Both
		// sides derive the same path, so the config never names a file nothing created.
		projectedGitConfig = identity
			? createProjectedGitConfig(identity, {
					credentialHelper: gitCredentialHelperCommand(
						join(policyResult.policy.workspace, ".apex-code", "sandbox-state"),
					),
				})
			: undefined;

		const launch = buildSandboxedCliLaunch({
			workspace: policyResult.policy.workspace,
			command: options.command,
			args: options.args,
			environment: options.environment,
			allowedHosts: options.allowedHosts,
			readOnlyPaths: options.readOnlyPaths,
			authPath: options.authPath,
			gitConfigPath: projectedGitConfig?.path,
			toolBinaries: options.toolBinaries,
			skillPaths: options.skillPaths,
			credentialChannel,
		});
		return await supervisor.launch(launch);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Failed to start OS sandbox.";
		dependencies.stderr.write(`Error: ${message}\n`);
		return 1;
	} finally {
		lease?.release();
		if (projectedGitConfig) rmSync(projectedGitConfig.directory, { force: true, recursive: true });
		const cleanupResults = await Promise.allSettled([supervisor.close(), credentialProxy?.close()]);
		for (const violation of violationStore.list()) {
			dependencies.stderr.write(
				`Sandbox violation (${violation.kind}): ${violation.command} — ${violation.detail}\n`,
			);
		}
		for (const result of cleanupResults) {
			if (result.status === "rejected") {
				dependencies.stderr.write("Warning: sandbox cleanup did not complete cleanly.\n");
			}
		}
	}
}
