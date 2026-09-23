import type { SourceInfo } from "../../../core/source-info.ts";
import { parseGitUrl } from "../../../utils/git.ts";

/** The package a palette entry came from, or nothing for one the user or the project wrote. */
function packageSource(sourceInfo: SourceInfo | undefined): string | undefined {
	const source = sourceInfo?.source.trim();
	if (!source) return undefined;
	if (source.startsWith("npm:")) return source;
	const git = parseGitUrl(source);
	return git ? `git:${git.host}/${git.path}${git.ref ? `@${git.ref}` : ""}` : undefined;
}

/**
 * A palette description, led by the package it came from when there is one. A resource the
 * user or the project wrote carries no tag: a scope letter told the reader nothing they
 * could act on.
 */
export function describeWithSource(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
	const source = packageSource(sourceInfo);
	if (!source) return description;
	return description ? `[${source}] ${description}` : `[${source}]`;
}
