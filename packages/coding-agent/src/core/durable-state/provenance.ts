import { spawnProcessSync } from "../../utils/child-process.ts";

export interface GitProvenance {
	repositoryRoot?: string;
	revision?: string;
	dirty?: boolean;
}

export function readGitProvenance(cwd: string): GitProvenance {
	const root = spawnProcessSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (root.status !== 0 || !root.stdout.trim()) return {};
	const repositoryRoot = root.stdout.trim();
	const revision = spawnProcessSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const dirty = spawnProcessSync("git", ["-C", repositoryRoot, "status", "--porcelain"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return {
		repositoryRoot,
		...(revision.status === 0 && revision.stdout.trim() ? { revision: revision.stdout.trim() } : {}),
		...(dirty.status === 0 ? { dirty: Boolean(dirty.stdout.trim()) } : {}),
	};
}
