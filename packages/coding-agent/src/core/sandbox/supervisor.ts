import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSandboxEnforcement, type SandboxPolicy, type SandboxStatus } from "./policy.ts";

export interface SandboxLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly policy: SandboxPolicy;
	/**
	 * A supervisor-owned private directory. Platform backends must never derive this
	 * from the workspace or fall back to it.
	 */
	readonly supervisorStateDirectory: string;
	readonly environment?: NodeJS.ProcessEnv;
	/** Application/runtime directories needed by the child but never writable by it. */
	readonly readOnlyPaths?: readonly string[];
	/** Individual read-only files, such as a host-owned credential file. */
	readonly readOnlyFiles?: readonly string[];
	/**
	 * Host executables projected read-only at an exact path inside the child. The
	 * destination is chosen by the caller because only it knows where the child will
	 * look; the backend just places the file there without write access.
	 */
	readonly readOnlyBinaries?: readonly { readonly source: string; readonly destination: string }[];
	/**
	 * The supervisor-owned credential write channel, when one was opened for this
	 * launch. `hostSocketPath` is where the supervisor's writer listens; the backend
	 * projects it to `childSocketPath`, which is also what the child is told through
	 * `APEX_CREDENTIAL_PROXY_PATH`. Absent means the session has no credential write
	 * path at all -- the mount stays read-only with no exception.
	 */
	readonly credentialChannel?: {
		readonly hostSocketPath: string;
		readonly childSocketPath: string;
	};
}

/** A platform adapter. Its sole job is to launch a normal Apex child inside an OS boundary. */
export interface SandboxBackend {
	readonly status: SandboxStatus;
	launch(launch: SandboxLaunch): Promise<number>;
	close(): Promise<void>;
}

export interface SandboxSupervisor {
	readonly status: SandboxStatus;
	/**
	 * The supervisor may allocate this for low-level callers and tests. The backend
	 * still receives a required, private path on every launch.
	 */
	launch(
		options: Omit<SandboxLaunch, "policy" | "supervisorStateDirectory"> & {
			readonly supervisorStateDirectory?: string;
		},
	): Promise<number>;
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
			const ownsStateDirectory = launch.supervisorStateDirectory === undefined;
			const supervisorStateDirectory =
				launch.supervisorStateDirectory ??
				mkdtempSync(join(tmpdir(), `apex-supervisor-${process.pid}-`), { encoding: "utf8" });
			if (ownsStateDirectory) chmodSync(supervisorStateDirectory, 0o700);
			try {
				return await options.backend.launch({ ...launch, supervisorStateDirectory, policy: options.policy });
			} finally {
				if (ownsStateDirectory) rmSync(supervisorStateDirectory, { force: true, recursive: true });
			}
		},
		async close() {
			await options.backend.close();
		},
	};
}
