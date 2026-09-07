import { statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

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
	const target = resolve(path);
	const parent = dirname(target);
	return [...ancestorDirectoryArguments(parent), "--ro-bind", parent, parent];
}

/** Directory paths are mounted from matching fd 3 onward to preserve sibling exclusion. */
export function descriptorBackedReadOnlyPaths(paths: readonly string[]): string[] {
	return paths.filter((path) => {
		try {
			return statSync(resolve(path)).isDirectory();
		} catch {
			return false;
		}
	});
}

interface DescriptorBackedDirectory {
	readonly path: string;
	readonly descriptor: number;
}

interface DescriptorBackedFile extends DescriptorBackedDirectory {}

interface ProjectionGroup {
	readonly directories: DescriptorBackedDirectory[];
	readonly files: DescriptorBackedFile[];
}

function isWithin(path: string, root: string): boolean {
	const target = resolve(path);
	const boundary = resolve(root);
	return target === boundary || target.startsWith(boundary.endsWith(sep) ? boundary : `${boundary}${sep}`);
}

function nestedReadOnlyMountArguments(projections: readonly DescriptorBackedDirectory[]): string[] {
	return projections.flatMap(({ path, descriptor }) => {
		const target = resolve(path);
		return ["--ro-bind", `/proc/self/fd/${descriptor}`, target];
	});
}

function externalReadOnlyMountArguments(
	directories: readonly DescriptorBackedDirectory[],
	files: readonly DescriptorBackedFile[],
	writableRoots: readonly string[],
): string[] {
	const byParent = new Map<string, ProjectionGroup>();
	const add = (kind: keyof ProjectionGroup, projection: DescriptorBackedDirectory): void => {
		const parent = dirname(resolve(projection.path));
		const group = byParent.get(parent) ?? { directories: [], files: [] };
		group[kind].push(projection);
		byParent.set(parent, group);
	};
	for (const directory of directories) add("directories", directory);
	for (const file of files) add("files", file);

	const groups = [...byParent].sort(([left], [right]) => left.split(sep).length - right.split(sep).length);
	const laterMountpoints = [...byParent.keys(), ...writableRoots];
	return groups.flatMap(([parent, group]) => [
		...ancestorDirectoryArguments(parent),
		"--tmpfs",
		parent,
		...laterMountpoints
			.filter((mountpoint) => mountpoint !== parent && isWithin(mountpoint, parent))
			.flatMap(ancestorDirectoryArguments),
		...group.directories.flatMap(({ path, descriptor }) => {
			const target = resolve(path);
			return ["--dir", target, "--ro-bind", `/proc/self/fd/${descriptor}`, target];
		}),
		...group.files.flatMap(({ path, descriptor }) => [
			"--perms",
			"0400",
			"--file",
			String(descriptor),
			resolve(path),
		]),
		"--remount-ro",
		parent,
	]);
}

/** Build the complete argv. Mount order below is load-bearing; the comments say why. */
export function buildBwrapArguments(spec: BwrapSpec): string[] {
	const directoryPaths = descriptorBackedReadOnlyPaths(spec.readOnlyPaths);
	const ordinaryPaths = spec.readOnlyPaths.filter((path) => !directoryPaths.includes(path));
	const writableRoots = [spec.workspace, ...spec.additionalWritableRoots];
	const directoryMounts = directoryPaths.map((path, index) => ({ path, descriptor: 3 + index }));
	const fileMounts = spec.readOnlyFiles.map((path, index) => ({
		path,
		descriptor: 3 + directoryPaths.length + index,
	}));
	const nestedDirectoryMounts = directoryMounts.filter(({ path }) =>
		writableRoots.some((root) => isWithin(path, root)),
	);
	const externalDirectoryMounts = directoryMounts.filter(({ path }) =>
		writableRoots.every((root) => !isWithin(path, root)),
	);
	const nestedFileMounts = fileMounts.filter(({ path }) => writableRoots.some((root) => isWithin(path, root)));
	const externalFileMounts = fileMounts.filter(({ path }) => writableRoots.every((root) => !isWithin(path, root)));
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
		// External directory projections shadow their parent to exclude siblings. Do
		// that before writable roots. The root binds below restore paths that the
		// projection's parent shadow may have hidden.
		...externalReadOnlyMountArguments(externalDirectoryMounts, externalFileMounts, writableRoots),
		...writableRoots.flatMap((root) => ["--dir", root]),
		"--bind",
		spec.workspace,
		spec.workspace,
		// Each extra root is bound exactly as the workspace is, and only ever from an
		// argv-parsed flag: a repository that could name its own writable root would be
		// granting itself authority (ADR 0016).
		...spec.additionalWritableRoots.flatMap((root) => ["--bind", root, root]),
		// These mounts must follow the writable roots: otherwise binding a workspace
		// would mask a read-only projection nested inside it.
		...ordinaryPaths.flatMap((path) => readOnlyMountArguments(path)),
		// A directory already inside a writable root needs no parent shadow: that root
		// already exposes its siblings by policy. Rebind only the requested directory.
		...nestedReadOnlyMountArguments([...nestedDirectoryMounts, ...nestedFileMounts]),
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
