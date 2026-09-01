import {
	type CheckpointSettings,
	createGitCheckpoints,
	type GitCheckpoint,
	type GitCheckpoints,
} from "./git-checkpoints.ts";

export interface SessionCheckpointsOptions {
	readonly workspace: string;
	readonly sessionId: string;
	readonly settings: CheckpointSettings | undefined;
}

export interface SessionCheckpoints {
	/** Snapshot the worktree against one session entry. Undefined whenever checkpoints are off or unavailable. */
	capture(entryId: string): Promise<GitCheckpoint | undefined>;
	/** The engine, once resolved. Undefined until the first capture, and whenever checkpoints are off. */
	engine(): Promise<GitCheckpoints | undefined>;
}

/**
 * The session's view of the checkpoint engine.
 *
 * Resolution is lazy and happens at most once. Two things force that. The engine is
 * async because it shells out to `git rev-parse` to decide whether a repository is even
 * there, and session construction is not; and the workspace may not be a repository at
 * all, which is a supported state rather than an error, so nothing may throw out of here
 * into a turn.
 */
export function createSessionCheckpoints(options: SessionCheckpointsOptions): SessionCheckpoints {
	/**
	 * Absent settings mean ON (spec 2026-09-01-checkpoints-default-on.md): the
	 * rewind safety net must not require discovering a settings key. The explicit
	 * opt-out is `{ enabled: false }`. Outside a git repository the engine
	 * resolves to undefined -- one swallowed `git rev-parse` at the first capture
	 * attempt -- so a non-repo workspace stays a supported no-subsystem state.
	 */
	const enabled = options.settings?.enabled !== false;
	let resolved: Promise<GitCheckpoints | undefined> | undefined;

	const engine = (): Promise<GitCheckpoints | undefined> => {
		if (!enabled) return Promise.resolve(undefined);
		resolved ??= createGitCheckpoints(options.workspace, options.sessionId, {
			maxPerSession: options.settings?.maxPerSession,
		}).catch(() => undefined);
		return resolved;
	};

	return {
		engine,
		async capture(entryId) {
			return (await engine())?.capture(entryId);
		},
	};
}
