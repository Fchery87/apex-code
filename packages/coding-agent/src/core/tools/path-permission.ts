/** Shared PermissionSpec construction for the path-shaped tools (read, grep, find, ls, write, edit). */

import { minimatch } from "minimatch";
import type { Static, TSchema } from "typebox";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { PermissionBehavior, PermissionSpec } from "./contract.ts";

/**
 * Builds a glob-based PermissionSpec over a single path field. `getPath` extracts
 * the workspace path a call touches (returning undefined defaults to the tool's own
 * cwd-relative root, e.g. `ls` with no `path` argument). Rule content is a
 * cwd-relative glob; `ruleForCall` returns the exact normalized path of the call, so
 * "always allow this" authorizes only that path — never a pattern the tool did not
 * generate itself.
 */
export function createPathPermissionSpec<TParams extends TSchema>(options: {
	cwd: string;
	defaultBehavior: PermissionBehavior;
	verb: string;
	getPath: (params: Static<TParams>) => string | undefined;
}): PermissionSpec<TParams> {
	const { cwd, defaultBehavior, verb, getPath } = options;

	const normalize = (path: string | undefined): string =>
		formatPathRelativeToCwdOrAbsolute(path && path.trim() ? path : ".", cwd);

	return {
		defaultBehavior,
		matches(ruleContent, params) {
			return minimatch(normalize(getPath(params)), ruleContent, { dot: true });
		},
		describe(ruleContent) {
			return `${verb} paths matching "${ruleContent}"`;
		},
		ruleForCall(params) {
			return normalize(getPath(params));
		},
	};
}
