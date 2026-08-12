import { requireSandboxEnforcement, type SandboxPolicy, type SandboxStatus } from "./policy.ts";

export interface SandboxLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly policy: SandboxPolicy;
	readonly environment?: NodeJS.ProcessEnv;
	/** Application/runtime paths needed by the child but never writable by it. */
	readonly readOnlyPaths?: readonly string[];
}

/** A platform adapter. Its sole job is to launch a normal Apex child inside an OS boundary. */
export interface SandboxBackend {
	readonly status: SandboxStatus;
	launch(launch: SandboxLaunch): Promise<number>;
	close(): Promise<void>;
}

export interface SandboxSupervisor {
	readonly status: SandboxStatus;
	launch(options: Omit<SandboxLaunch, "policy">): Promise<number>;
	close(): Promise<void>;
}

/**
 * Owns fail-closed policy propagation and lifecycle; OS details remain behind the
 * backend so all testable security semantics are Apex-owned.
 */
export function createSandboxSupervisor(options: {
	backend: SandboxBackend;
	policy: SandboxPolicy;
}): SandboxSupervisor {
	return {
		status: options.backend.status,
		async launch(launch) {
			requireSandboxEnforcement(options.backend.status);
			return options.backend.launch({ ...launch, policy: options.policy });
		},
		async close() {
			await options.backend.close();
		},
	};
}
