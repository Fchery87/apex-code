import { dirname, resolve } from "node:path";

/**
 * The single source of the child's `bwrap` argv.
 *
 * Extracted when per-command escalation needed a second child. Two hand-maintained argv
 * builders is the divergence ADR 0010 exists to prevent for tool contracts, and it is
 * worse here: a mount tightened in the primary child and missed in the escalated one
 * would be invisible until the escalated path was the one that mattered. Everything that
 * differs between the two children is an input to this function, so there is nothing to
 * keep in sync by hand.
 */

/** A unix socket projected from the host into the child. */
export interface BwrapSocketMount {
	readonly hostPath: string;
	readonly childPath: string;
}

/** A host executable placed read-only at an exact path inside the child. */
export interface BwrapBinaryMount {
	readonly source: string;
	readonly destination: string;
}

export interface BwrapSpec {
	/** The primary writable root, and where the child starts. */
	readonly workspace: string;
	/** Further writable roots, each bound exactly as the workspace is. */
	readonly additionalWritableRoots: readonly string[];
	/** Directories whose contents the child may read but not write. */
	readonly readOnlyPaths: readonly string[];
	/** Individual read-only files, projected by descriptor from index 3 upward. */
	readonly readOnlyFiles: readonly string[];
	readonly readOnlyBinaries: readonly BwrapBinaryMount[];
	readonly sockets: readonly BwrapSocketMount[];
	readonly environment: Readonly<Record<string, string>>;
	readonly command: string;
	readonly args: readonly string[];
}

function ancestorDirectoryArguments(directory: string): string[] {
	const ancestors: string[] = [];
	let current = directory;
	while (current !== "/" && current !== "/home") {
		ancestors.push(current);
		current = dirname(current);
	}
	return ancestors.reverse().flatMap((ancestor) => ["--dir", ancestor]);
}

export function readOnlyMountArguments(path: string): string[] {
	const directory = dirname(resolve(path));
	return [...ancestorDirectoryArguments(directory), "--ro-bind", directory, directory];
}

/**
 * Project every read-only file, grouped by the directory each one lives in.
 *
 * A file needs a `--tmpfs` over its parent to have somewhere to be mounted, and that
 * tmpfs replaces whatever the parent held. Emitting one per file meant two files sharing
 * a directory produced two `--tmpfs` on the same path, and the second silently masked the
 * first -- the child saw one file and got ENOENT for the other. Grouping keeps a single
 * tmpfs per directory carrying every file bound into it.
 *
 * Descriptor numbers stay tied to each path's index in the original list, because the
 * caller opens them in that order and passes them to `spawn` as `stdio` entries 3 onward.
 */
export function readOnlyFileMountArguments(paths: readonly string[], firstDescriptor = 3): string[] {
	const byDirectory = new Map<string, { target: string; descriptor: number }[]>();
	paths.forEach((path, index) => {
		const target = resolve(path);
		const directory = dirname(target);
		const group = byDirectory.get(directory);
		const entry = { target, descriptor: firstDescriptor + index };
		if (group) group.push(entry);
		else byDirectory.set(directory, [entry]);
	});
	return [...byDirectory].flatMap(([directory, files]) => [
		...ancestorDirectoryArguments(directory),
		"--tmpfs",
		directory,
		...files.flatMap(({ target, descriptor }) => ["--perms", "0400", "--file", String(descriptor), target]),
	]);
}

/** Build the complete argv. Mount order below is load-bearing; the comments say why. */
export function buildBwrapArguments(spec: BwrapSpec): string[] {
	return [
		"--new-session",
		"--die-with-parent",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--ro-bind",
		"/",
		"/",
		"--tmpfs",
		"/home",
		// Immediately after the /home tmpfs: that is the only writable mount at this
		// point, so it is the only place bwrap can create a socket mountpoint.
		...spec.sockets.flatMap(({ hostPath, childPath }) => ["--bind", hostPath, childPath]),
		...spec.readOnlyPaths.flatMap((path) => readOnlyMountArguments(path)),
		...readOnlyFileMountArguments(spec.readOnlyFiles),
		"--bind",
		spec.workspace,
		spec.workspace,
		// Each extra root is bound exactly as the workspace is, and only ever from an
		// argv-parsed flag: a repository that could name its own writable root would be
		// granting itself authority (ADR 0016).
		...spec.additionalWritableRoots.flatMap((root) => ["--bind", root, root]),
		// After the workspace bind: these destinations sit inside it, and an earlier mount
		// would be masked when the workspace is bound over them.
		...spec.readOnlyBinaries.flatMap(({ source, destination }) => ["--ro-bind", source, destination]),
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--chdir",
		spec.workspace,
		...Object.entries(spec.environment).flatMap(([name, value]) => ["--setenv", name, value]),
		"--",
		spec.command,
		...spec.args,
	];
}
