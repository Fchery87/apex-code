import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "apex-code-agent-core";
import nodePath from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext } from "../extensions/types.ts";
import { getPreparedPathOperation } from "../permissions/operations.ts";
import type { ApexToolDefinition } from "./contract.ts";
import { createPathPermissionSpec } from "./path-permission.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { lsRenderers } from "./renderers/ls.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	/** Entries in the directory before the limit was applied. Present only when truncated. */
	totalEntries?: number;
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ApexToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		contract: {
			capabilities: new Set(["fs.read"]),
			permission: createPathPermissionSpec({
				cwd,
				defaultBehavior: "allow",
				verb: "List",
				getPath: (params) => params.path,
			}),
			context: { resultRecoverable: true, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(
			_toolCallId,
			input: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const { path, limit } = input;
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const prepared = getPreparedPathOperation(input);
						const dirPath = prepared ? prepared.path.value : resolveToCwd(path || ".", ctx?.cwd || cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists.
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// Check if path is a directory.
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// Read directory entries.
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// Sort alphabetically, case-insensitive.
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators.
						const results: string[] = [];
						let entryLimitReached = false;
						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";
							try {
								const entryStat = await ops.stat(fullPath);
								if (entryStat.isDirectory()) suffix = "/";
							} catch {
								// Skip entries we cannot stat.
								continue;
							}
							results.push(entry + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						const rawOutput = results.join("\n");
						// Apply byte truncation. There is no separate line limit because entry count is already capped.
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// Build actionable notices for truncation and entry limits.
						const notices: string[] = [];
						if (entryLimitReached) {
							// The whole listing was read before capping, so the total is already in
							// hand. Reporting it is what lets the agent decide whether it has seen
							// everything instead of spending a second call to find out.
							notices.push(
								`${results.length} of ${entries.length} total entries shown. Use limit=${effectiveLimit * 2} for more`,
							);
							details.entryLimitReached = effectiveLimit;
							details.totalEntries = entries.length;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		...lsRenderers,
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
