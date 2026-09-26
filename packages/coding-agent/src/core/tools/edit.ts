import { createHash } from "node:crypto";
import type { AgentTool } from "apex-code-agent-core";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { getPreparedPathOperation, type PreparedPathOperation } from "../permissions/operations.ts";
import type { PermissionPreview } from "../permissions/responder.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import type { DiagnosticsOperations, DiagnosticsOutcome } from "./diagnostics.ts";
import { diagnosticEvidenceForPath, formatDiagnosticsOutcome } from "./diagnostics.ts";
import {
	applyEditsToNormalizedContent,
	computeEditsDiffFromContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { createPathPermissionSpec } from "./path-permission.ts";
import { readPreparedPath, resolveToCwd, writePathAtomically, writePreparedPath } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Present only when `EditToolOptions.diagnosticsOperations` is configured (LSP.4). */
	diagnostics?: DiagnosticsOutcome;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/**
	 * Execute a gate-prepared edit no-follow against the authorized target.
	 * Required for gated calls: when a prepared operation exists, pathname reads
	 * and writes are never used, so an unset implementation fails closed.
	 */
	readPreparedFile?: (operation: PreparedPathOperation) => Buffer;
	writePreparedFile?: (operation: PreparedPathOperation, content: Buffer) => void;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: async (path, content) => writePathAtomically(path, content),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
	readPreparedFile: (operation) => readPreparedPath(operation),
	writePreparedFile: (operation, content) => writePreparedPath(operation, content),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/**
	 * Optional post-mutation diagnostics (LSP.4). Absent by default -- byte-identical
	 * existing behavior. When present, called inside `withFileMutationQueue` after the
	 * write succeeds and before the queue releases, matching `TestOperations`/
	 * `GrepOperations`' injection pattern (`test.ts:28`, `grep.ts:58`).
	 */
	diagnosticsOperations?: DiagnosticsOperations;
}

/** A preview is a courtesy, so it never costs more than a screen or two of reading. */
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_MAX_LINES = 40;

/**
 * Describe the edit for the person deciding whether to allow it.
 *
 * Reads through the operation `prepareCall` stored rather than resolving the
 * pathname again, so a target swapped after authorization fails here exactly as
 * it fails the write. `readPreparedPath` throws in that case and the gate turns
 * the throw into a stated reason, which is the outcome a reader needs: better a
 * prompt that admits it cannot show the change than a diff of the wrong file.
 */
function previewEdit(params: EditToolInput): PermissionPreview {
	const prepared = getPreparedPathOperation(params);
	if (!prepared) return { kind: "unavailable", reason: "No authorized target was prepared for this call" };
	if (prepared.kind === "path-new") {
		return { kind: "summary", lines: [`Create ${params.path}`] };
	}

	const buffer = readPreparedPath(prepared, PREVIEW_MAX_BYTES + 1);
	if (buffer.byteLength > PREVIEW_MAX_BYTES) {
		return { kind: "unavailable", reason: `File is larger than ${PREVIEW_MAX_BYTES / 1024}KB, so no diff is shown` };
	}
	if (buffer.includes(0)) {
		return { kind: "unavailable", reason: "File is binary, so there is no diff to show" };
	}

	const result = computeEditsDiffFromContent(params.path, buffer.toString("utf-8"), params.edits as Edit[]);
	if ("error" in result) return { kind: "unavailable", reason: result.error };

	const lines = result.diff.split("\n");
	const shown = lines.slice(0, PREVIEW_MAX_LINES);
	return { kind: "diff", path: params.path, lines: shown, omittedLines: lines.length - shown.length };
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ApexToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const diagnosticsOperations = options?.diagnosticsOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		contract: {
			capabilities: new Set(["fs.read", "fs.write"]),
			permission: createPathPermissionSpec({
				cwd,
				defaultBehavior: "ask",
				verb: "Edit",
				getPath: (params) => params.path,
				previewCall: (params) => previewEdit(params as EditToolInput),
			}),
			context: { resultRecoverable: true, deferSchema: false },
			evidence: {
				emits: new Set(diagnosticsOperations ? ["diff", "diagnostic"] : ["diff"]),
				capture: (params, result) => {
					const patch = result.details?.patch;
					const records: EvidenceRecord[] = patch
						? [{ kind: "diff", path: params.path, patchHash: sha256(patch) }]
						: [{ kind: "diff", path: params.path }];
					const diagnostics = result.details?.diagnostics;
					if (diagnostics) records.push(diagnosticEvidenceForPath(params.path, diagnostics));
					return records;
				},
			},
		},
		constrainedSampling: getExperimentalToolSampling(),
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits } = validateEditInput(input);
			const prepared = getPreparedPathOperation(input);
			const absolutePath = prepared?.path.value ?? resolveToCwd(path, ctx?.cwd || cwd);
			if (prepared && (!ops.readPreparedFile || !ops.writePreparedFile)) {
				throw new Error("No safe prepared edit operation is available for this gated edit");
			}

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists (skipped for a gated call: the prepared operation
				// already proves existence, and the no-follow read enforces the identity).
				try {
					if (!prepared) await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = prepared ? ops.readPreparedFile!(prepared) : await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				if (prepared) ops.writePreparedFile!(prepared, Buffer.from(finalContent, "utf-8"));
				else await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				const successText = `Successfully replaced ${edits.length} block(s) in ${path}.`;

				if (diagnosticsOperations) {
					const diagnostics = await diagnosticsOperations.afterMutation(absolutePath, signal);
					return {
						content: [{ type: "text", text: `${successText}\n\n${formatDiagnosticsOutcome(diagnostics)}` }],
						details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine, diagnostics },
					};
				}

				return {
					content: [{ type: "text", text: successText }],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
