/** Shared PermissionSpec construction for the path-shaped tools (read, grep, find, ls, write, edit). */

import { basename, dirname } from "node:path";
import { minimatch } from "minimatch";
import type { Static, TSchema } from "typebox";
import { formatPathRelativeToCwdOrAbsolute, resolvesInsideDirectory } from "../../utils/paths.ts";
import { setPreparedPathOperation } from "../permissions/operations.ts";
import { describeProtectedTarget, isSensitivePath } from "../permissions/protected-paths.ts";
import type { PermissionPreview } from "../permissions/responder.ts";
import type { PermissionBehavior, PermissionSpec } from "./contract.ts";
import { preparePathOperation, resolveToCwd } from "./path-utils.ts";

/**
 * Escapes glob metacharacters in a literal path so a rule built from a directory name
 * matches only that directory. Each character becomes a one-character class, which
 * minimatch reads the same way on every platform, so no backslash escape is needed
 * (backslash is the path separator on Windows). `!` is left alone: it only negates
 * when it opens the whole pattern, and every path-scoped rule opens with an absolute path.
 */
export function escapeGlobLiteral(value: string): string {
	return value.replace(/[[\]*?{}()+@]/g, (char) => `[${char}]`);
}

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
	/**
	 * Read-shaped tools set this. A target outside the workspace asks by default, and an
	 * "always allow" saves a rule for its directory rather than the single file.
	 * `"target"` means the path itself is the directory (grep, find, ls). `"parent"`
	 * means the path is a file and its directory is the scope (read).
	 */
	outsideWorkspace?: "target" | "parent";
}): PermissionSpec<TParams> {
	const { cwd, defaultBehavior, verb, getPath, previewCall, outsideWorkspace } = options;

	const normalize = (path: string | undefined): string => {
		const canonical = resolveToCwd(path?.trim() ? path : ".", cwd);
		return formatPathRelativeToCwdOrAbsolute(canonical, cwd);
	};
	const escapeExact = (value: string): string => `exact:${value}`;
	const isSensitive = (params: Static<TParams>): boolean => {
		const path = getPath(params);
		return isSensitivePath(resolveToCwd(path?.trim() ? (path as string) : ".", cwd));
	};
	const isOutside = (params: Static<TParams>): boolean => {
		const path = getPath(params);
		return !resolvesInsideDirectory(resolveToCwd(path?.trim() ? (path as string) : ".", cwd), cwd);
	};

	return {
		defaultBehavior,
		defaultBehaviorFor(params: Static<TParams>) {
			if (isSensitive(params)) return "ask";
			if (outsideWorkspace && isOutside(params)) return "ask";
			return undefined;
		},
		allowRuleGrants(ruleContent: string | undefined, params: Static<TParams>) {
			if (!isSensitive(params)) return true;
			if (ruleContent === undefined) return false;
			const named = ruleContent.startsWith("exact:") ? ruleContent.slice("exact:".length) : ruleContent;
			return basename(named) === basename(normalize(getPath(params)));
		},
		prepareCall(params) {
			setPreparedPathOperation(params as object, preparePathOperation(getPath(params) ?? ".", cwd));
		},
		...(previewCall ? { previewCall } : {}),
		protectedTarget(params) {
			return describeProtectedTarget(resolveToCwd(getPath(params)?.trim() ? (getPath(params) as string) : ".", cwd));
		},
		withinWorkspace(params) {
			return resolvesInsideDirectory(
				resolveToCwd(getPath(params)?.trim() ? (getPath(params) as string) : ".", cwd),
				cwd,
			);
		},
		matches(ruleContent, params) {
			return ruleContent.startsWith("exact:")
				? normalize(getPath(params)) === ruleContent.slice("exact:".length)
				: minimatch(normalize(getPath(params)), ruleContent, { dot: true });
		},
		describe(ruleContent) {
			return `${verb} paths matching "${ruleContent}"`;
		},
		ruleForCall(params) {
			if (outsideWorkspace && isOutside(params) && !isSensitive(params)) {
				const target = normalize(getPath(params));
				const scope = outsideWorkspace === "parent" ? dirname(target) : target;
				return `${escapeGlobLiteral(scope)}/**`;
			}
			return escapeExact(normalize(getPath(params)));
		},
	};
}
