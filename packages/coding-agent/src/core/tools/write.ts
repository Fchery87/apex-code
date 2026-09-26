import { createHash } from "node:crypto";
import type { AgentTool } from "apex-code-agent-core";
import { mkdir as fsMkdir } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { getPreparedPathOperation, type PreparedPathOperation } from "../permissions/operations.ts";
import type { PermissionPreview } from "../permissions/responder.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import type { DiagnosticsOperations, DiagnosticsOutcome } from "./diagnostics.ts";
import { diagnosticEvidenceForPath, formatDiagnosticsOutcome } from "./diagnostics.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { createPathPermissionSpec } from "./path-permission.ts";
import { readPreparedPath, resolveToCwd, writePathAtomically, writePreparedPath } from "./path-utils.ts";
import { writeRenderers } from "./renderers/write.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	byteCount: number;
	contentHash: string;
	/** Present only when `WriteToolOptions.diagnosticsOperations` is configured (LSP.4). */
	diagnostics?: DiagnosticsOutcome;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
	/**
	 * Execute a gate-prepared write no-follow against the authorized target.
	 * Required for gated calls: when a prepared operation exists, pathname writes
	 * are never used, so an unset implementation fails closed.
	 */
	writePrepared?: (operation: PreparedPathOperation, content: string) => void;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: async (path, content) => writePathAtomically(path, content),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	writePrepared: (operation, content) => writePreparedPath(operation, content),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/**
	 * Optional post-mutation diagnostics (LSP.4). Absent by default -- byte-identical
	 * existing behavior. When present, called inside `withFileMutationQueue` after the
	 * write succeeds and before the queue releases, matching `TestOperations`/
	 * `GrepOperations`' injection pattern (`test.ts:28`, `grep.ts:58`).
	 */
	diagnosticsOperations?: DiagnosticsOperations;
}

const WRITE_PREVIEW_MAX_BYTES = 512 * 1024;

/** A trailing newline terminates the last line rather than starting an empty one. */
const countLines = (text: string): number => {
	if (text === "") return 0;
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n").length;
};

const lineCount = (text: string): string => {
	const n = countLines(text);
	return `${n} ${n === 1 ? "line" : "lines"}`;
};

/**
 * Describe a whole-file replacement without drawing the whole file.
 *
 * A diff of a write is the file twice over, which is not what a person needs in
 * order to decide. Sizes on both sides answer the question that matters, which is
 * whether this replaces something substantial. Read through the prepared
 * operation, so a swapped target fails here as it fails the write (ADR 0029).
 */
function previewWrite(params: { path: string; content: string }): PermissionPreview {
	const incoming = `${lineCount(params.content)}, ${Buffer.byteLength(params.content)} bytes`;
	const prepared = getPreparedPathOperation(params);
	if (!prepared) return { kind: "unavailable", reason: "No authorized target was prepared for this call" };
	if (prepared.kind === "path-new") {
		return { kind: "summary", lines: [`Create ${params.path} with ${incoming}`] };
	}

	const buffer = readPreparedPath(prepared, WRITE_PREVIEW_MAX_BYTES + 1);
	if (buffer.byteLength > WRITE_PREVIEW_MAX_BYTES) {
		return {
			kind: "summary",
			lines: [`Replace ${params.path}, over ${WRITE_PREVIEW_MAX_BYTES / 1024}KB, with ${incoming}`],
		};
	}
	const existing = buffer.includes(0)
		? `${buffer.byteLength} bytes of binary`
		: `${lineCount(buffer.toString("utf-8"))}, ${buffer.byteLength} bytes`;
	return { kind: "summary", lines: [`Replace ${params.path}`, `${existing} becomes ${incoming}`] };
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ApexToolDefinition<typeof writeSchema, WriteToolDetails> {
	const ops = options?.operations ?? defaultWriteOperations;
	const diagnosticsOperations = options?.diagnosticsOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		contract: {
			capabilities: new Set(["fs.write"]),
			permission: createPathPermissionSpec({
				cwd,
				defaultBehavior: "ask",
				verb: "Write",
				getPath: (params) => params.path,
				previewCall: (params) => previewWrite(params as { path: string; content: string }),
			}),
			context: { resultRecoverable: true, deferSchema: false },
			evidence: {
				emits: new Set(diagnosticsOperations ? ["diff", "diagnostic"] : ["diff"]),
				capture: (params, result) => {
					const details = result.details;
					const records: EvidenceRecord[] = details
						? [
								{
									kind: "diff",
									path: params.path,
									byteCount: details.byteCount,
									contentHash: details.contentHash,
								},
							]
						: [{ kind: "diff", path: params.path }];
					if (details?.diagnostics) records.push(diagnosticEvidenceForPath(params.path, details.diagnostics));
					return records;
				},
			},
		},
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			input: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const { path, content } = input;
			const prepared = getPreparedPathOperation(input);
			const absolutePath = prepared?.path.value ?? resolveToCwd(path, ctx?.cwd || cwd);
			if (prepared && !ops.writePrepared) {
				throw new Error("No safe prepared write operation is available for this gated write");
			}
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				if (prepared) {
					// Gated path: no-follow execution against the exact authorized target.
					ops.writePrepared!(prepared, content);
					throwIfAborted();
				} else {
					// Create parent directories if needed.
					await ops.mkdir(dir);
					throwIfAborted();

					// Write the file contents.
					await ops.writeFile(absolutePath, content);
					throwIfAborted();
				}

				const successText = `Successfully wrote to ${path}`;

				if (diagnosticsOperations) {
					const diagnostics = await diagnosticsOperations.afterMutation(absolutePath, signal);
					return {
						content: [{ type: "text", text: `${successText}\n\n${formatDiagnosticsOutcome(diagnostics)}` }],
						details: { byteCount: Buffer.byteLength(content), contentHash: sha256(content), diagnostics },
					};
				}

				return {
					content: [{ type: "text", text: successText }],
					details: { byteCount: Buffer.byteLength(content), contentHash: sha256(content) },
				};
			});
		},
		...writeRenderers,
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
