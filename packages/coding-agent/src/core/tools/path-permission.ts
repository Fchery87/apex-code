/** Shared PermissionSpec construction for the path-shaped tools (read, grep, find, ls, write, edit). */

import { minimatch } from "minimatch";
import type { Static, TSchema } from "typebox";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { setPreparedPathOperation } from "../permissions/operations.ts";
import type { PermissionPreview } from "../permissions/responder.ts";
import type { PermissionBehavior, PermissionSpec } from "./contract.ts";
import { preparePathOperation, resolveToCwd } from "./path-utils.ts";

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
	/** Describes the change for a human about to approve it. See PermissionSpec.previewCall. */
	previewCall?: (params: Static<TParams>) => PermissionPreview;
}): PermissionSpec<TParams> {
	const { cwd, defaultBehavior, verb, getPath, previewCall } = options;

	const normalize = (path: string | undefined): string => {
		const canonical = resolveToCwd(path?.trim() ? path : ".", cwd);
		return formatPathRelativeToCwdOrAbsolute(canonical, cwd);
	};
	const escapeExact = (value: string): string => `exact:${value}`;

	return {
		defaultBehavior,
		prepareCall(params) {
			setPreparedPathOperation(params as object, preparePathOperation(getPath(params) ?? ".", cwd));
		},
		...(previewCall ? { previewCall } : {}),
		matches(ruleContent, params) {
			return ruleContent.startsWith("exact:")
				? normalize(getPath(params)) === ruleContent.slice("exact:".length)
				: minimatch(normalize(getPath(params)), ruleContent, { dot: true });
		},
		describe(ruleContent) {
			return `${verb} paths matching "${ruleContent}"`;
		},
		ruleForCall(params) {
			return escapeExact(normalize(getPath(params)));
		},
	};
}
