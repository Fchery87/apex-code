import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import type { ApexToolDefinition } from "./contract.ts";
import { applyEditsToNormalizedContent, detectLineEnding, normalizeToLF, restoreLineEndings } from "./edit-diff.ts";
import { createPathPermissionSpec } from "./path-permission.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 6. Several exact replacements
 * across files. Every file is computed first. A miss writes nothing.
 */

const patchSchema = Type.Object({
	patches: Type.Array(
		Type.Object({
			path: Type.String({ description: "File to change, relative to the workspace or absolute." }),
			oldText: Type.String({ description: "Exact text to replace. Must occur once." }),
			newText: Type.String({ description: "Replacement text." }),
		}),
		{ description: "Exact hunks. All apply, or none do." },
	),
});

export type ApplyPatchInput = Static<typeof patchSchema>;

interface Prepared {
	path: string;
	next: string;
}

export function createApplyPatchToolDefinition(
	cwd: string,
	options?: { denyInside?: string },
): ApexToolDefinition<typeof patchSchema, { files: string[] }> {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: "Apply exact text replacements across one or more files. All files change, or none do.",
		parameters: patchSchema,
		contract: {
			capabilities: new Set(["fs.write"]),
			permission: createPathPermissionSpec({
				cwd,
				defaultBehavior: "ask",
				verb: "Patch",
				denyInside: options?.denyInside,
				getPath: (params) => params.patches[0]?.path,
			}),
			context: { resultRecoverable: false, deferSchema: true },
			evidence: { emits: new Set(["diff"]), capture: () => [] },
		},
		async execute(_toolCallId, input) {
			const prepared: Prepared[] = [];
			for (const patch of input.patches) {
				const path = resolveToCwd(patch.path, cwd);
				const raw = await readFile(path, "utf8");
				const ending = detectLineEnding(raw);
				const normalized = normalizeToLF(raw);
				try {
					const { newContent } = applyEditsToNormalizedContent(
						normalized,
						[{ oldText: patch.oldText, newText: patch.newText }],
						path,
					);
					prepared.push({ path, next: restoreLineEndings(newContent, ending) });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`apply_patch stopped at ${path}: ${message}`);
				}
			}
			for (const file of prepared) {
				await writeFile(file.path, file.next, "utf8");
			}
			return {
				content: [{ type: "text" as const, text: `Patched ${prepared.length} file(s).` }],
				details: { files: prepared.map((file) => file.path) },
			};
		},
	};
}

export function createApplyPatchTool(
	cwd: string,
	options?: { denyInside?: string },
): AgentTool<typeof patchSchema, { files: string[] }> {
	return wrapToolDefinition(createApplyPatchToolDefinition(cwd, options));
}
