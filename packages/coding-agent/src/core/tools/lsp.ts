import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { ApexToolDefinition } from "./contract.ts";
import { createPathPermissionSpec } from "./path-permission.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MAX_LOCATIONS = 1_000;
const MAX_SYMBOLS = 2_000;

const lspNavigationSchema = Type.Object({
	operation: Type.Union([Type.Literal("definition"), Type.Literal("references")], {
		description: "Which navigation query to run.",
	}),
	path: Type.String({ description: "Path to the file (relative or absolute)." }),
	line: Type.Number({ description: "One-based line number." }),
	character: Type.Number({ description: "One-based UTF-16 character offset within the line." }),
});

const lspDocumentSymbolsSchema = Type.Object({
	operation: Type.Literal("document_symbols", { description: "List the symbols declared in a file." }),
	path: Type.String({ description: "Path to the file (relative or absolute)." }),
});

const lspSchema = Type.Union([lspNavigationSchema, lspDocumentSymbolsSchema]);

export type LspToolInput = Static<typeof lspSchema>;

export interface LspPosition {
	readonly line: number;
	readonly character: number;
}

export interface LspRange {
	readonly start: LspPosition;
	readonly end: LspPosition;
}

/** A navigation result normalized to a workspace-relative path and one-based range. */
export interface LspLocation {
	readonly path: string;
	readonly range: LspRange;
}

/** A flattened document symbol normalized to a workspace-relative path and one-based ranges. */
export interface LspSymbol {
	readonly name: string;
	readonly kind: number;
	readonly path: string;
	readonly range: LspRange;
	readonly selectionRange: LspRange;
	readonly detail?: string;
}

export type LspToolDetails =
	| { operation: "definition" | "references"; locations: LspLocation[]; omitted: number; truncated: number }
	| { operation: "document_symbols"; symbols: LspSymbol[]; omitted: number; truncated: number };

/**
 * Pluggable transport for the `lsp` tool. The executable, its arguments, and the
 * closed JSON-RPC method set are all fixed by configuration the tool never chooses
 * itself -- see contract.capabilities below for why that keeps this `{fs.read}`
 * rather than `{exec}`.
 */
export interface LspOperations {
	request(absolutePath: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface LspToolOptions {
	operations: LspOperations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is LspPosition {
	return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isRange(value: unknown): value is LspRange {
	return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function toOneBasedPosition(position: LspPosition): LspPosition {
	return { line: position.line + 1, character: position.character + 1 };
}

function toOneBasedRange(range: LspRange): LspRange {
	return { start: toOneBasedPosition(range.start), end: toOneBasedPosition(range.end) };
}

function fileUriToAbsolutePath(uri: string): string | undefined {
	if (!uri.startsWith("file:")) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

function rawLocationUriAndRange(value: unknown): { uri: string; range: LspRange } | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.uri === "string" && isRange(value.range)) return { uri: value.uri, range: value.range };
	if (typeof value.targetUri === "string" && isRange(value.targetRange)) {
		return { uri: value.targetUri, range: value.targetRange };
	}
	return undefined;
}

function normalizeLocations(raw: unknown, cwd: string): { locations: LspLocation[]; omitted: number } {
	const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const locations: LspLocation[] = [];
	let omitted = 0;
	for (const item of items) {
		const parsed = rawLocationUriAndRange(item);
		const absolutePath = parsed ? fileUriToAbsolutePath(parsed.uri) : undefined;
		if (!parsed || !absolutePath) {
			omitted++;
			continue;
		}
		locations.push({
			path: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd),
			range: toOneBasedRange(parsed.range),
		});
	}
	return { locations, omitted };
}

function compareLocations(a: LspLocation, b: LspLocation): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
	if (a.range.start.character !== b.range.start.character) return a.range.start.character - b.range.start.character;
	if (a.range.end.line !== b.range.end.line) return a.range.end.line - b.range.end.line;
	return a.range.end.character - b.range.end.character;
}

function dedupeSortAndCap(locations: LspLocation[], max: number): { locations: LspLocation[]; truncated: number } {
	const seen = new Set<string>();
	const unique: LspLocation[] = [];
	for (const location of locations) {
		const key = JSON.stringify(location);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(location);
	}
	unique.sort(compareLocations);
	const capped = unique.slice(0, max);
	return { locations: capped, truncated: unique.length - capped.length };
}

function isRawDocumentSymbol(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.name === "string" && isRange(value.range) && isRange(value.selectionRange);
}

function flattenSymbols(raw: unknown, path: string): { symbols: LspSymbol[]; omitted: number } {
	const symbols: LspSymbol[] = [];
	let omitted = 0;
	const visit = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		for (const item of value) {
			if (!isRawDocumentSymbol(item)) {
				omitted++;
				continue;
			}
			symbols.push({
				name: item.name as string,
				kind: typeof item.kind === "number" ? item.kind : 0,
				path,
				range: toOneBasedRange(item.range as LspRange),
				selectionRange: toOneBasedRange(item.selectionRange as LspRange),
				...(typeof item.detail === "string" ? { detail: item.detail } : {}),
			});
			if (Array.isArray(item.children)) visit(item.children);
		}
	};
	visit(Array.isArray(raw) ? raw : []);
	return { symbols, omitted };
}

function compareSymbols(a: LspSymbol, b: LspSymbol): number {
	if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
	if (a.range.start.character !== b.range.start.character) return a.range.start.character - b.range.start.character;
	return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
}

function capSymbols(symbols: LspSymbol[], max: number): { symbols: LspSymbol[]; truncated: number } {
	const sorted = [...symbols].sort(compareSymbols);
	const capped = sorted.slice(0, max);
	return { symbols: capped, truncated: sorted.length - capped.length };
}

function formatNotices(omitted: number, truncated: number): string {
	const notices: string[] = [];
	if (omitted > 0) notices.push(`${omitted} non-file result(s) omitted`);
	if (truncated > 0) notices.push(`${truncated} result(s) truncated`);
	return notices.length > 0 ? `\n\n[${notices.join(", ")}]` : "";
}

function formatLocationsText(
	operation: "definition" | "references",
	locations: LspLocation[],
	omitted: number,
	truncated: number,
): string {
	if (locations.length === 0) {
		return operation === "definition" ? "No definition found." : "No references found.";
	}
	const lines = locations.map(
		(location) => `${location.path}:${location.range.start.line}:${location.range.start.character}`,
	);
	return `${lines.join("\n")}${formatNotices(omitted, truncated)}`;
}

function formatSymbolsText(symbols: LspSymbol[], omitted: number, truncated: number): string {
	if (symbols.length === 0) return "No symbols found.";
	const lines = symbols.map(
		(symbol) => `${symbol.path}:${symbol.range.start.line}:${symbol.range.start.character} ${symbol.name}`,
	);
	return `${lines.join("\n")}${formatNotices(omitted, truncated)}`;
}

export function createLspToolDefinition(
	cwd: string,
	options: LspToolOptions,
): ApexToolDefinition<typeof lspSchema, LspToolDetails> {
	const { operations } = options;
	return {
		name: "lsp",
		label: "lsp",
		description: "Query the configured language server for definitions, references, or symbols.",
		parameters: lspSchema,
		contract: {
			// `grep` spawns `rg` and declares {fs.read}, not {exec}, because the caller
			// never chooses what runs -- the executable, args, and closed JSON-RPC
			// method set all come from settings.json / this tool's own code. Same
			// reasoning here: {exec} would silently widen a delegation ceiling for no
			// capability the model can actually reach through this tool.
			capabilities: new Set(["fs.read"]),
			permission: createPathPermissionSpec({
				cwd,
				defaultBehavior: "allow",
				verb: "Query",
				getPath: (params) => params.path,
			}),
			context: { resultRecoverable: true, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(_toolCallId, input: LspToolInput, signal?: AbortSignal) {
			const absolutePath = resolveToCwd(input.path, cwd);
			const uri = pathToFileURL(absolutePath).href;

			if (input.operation === "document_symbols") {
				const raw = await operations.request(
					absolutePath,
					"textDocument/documentSymbol",
					{ textDocument: { uri } },
					signal,
				);
				const relativePath = formatPathRelativeToCwdOrAbsolute(absolutePath, cwd);
				const { symbols, omitted } = flattenSymbols(raw, relativePath);
				const { symbols: capped, truncated } = capSymbols(symbols, MAX_SYMBOLS);
				return {
					content: [{ type: "text", text: formatSymbolsText(capped, omitted, truncated) }],
					details: { operation: "document_symbols", symbols: capped, omitted, truncated },
				};
			}

			const position = { line: input.line - 1, character: input.character - 1 };
			const method = input.operation === "definition" ? "textDocument/definition" : "textDocument/references";
			const params: Record<string, unknown> = { textDocument: { uri }, position };
			if (input.operation === "references") params.context = { includeDeclaration: true };
			const raw = await operations.request(absolutePath, method, params, signal);
			const { locations, omitted } = normalizeLocations(raw, cwd);
			const { locations: capped, truncated } = dedupeSortAndCap(locations, MAX_LOCATIONS);
			return {
				content: [{ type: "text", text: formatLocationsText(input.operation, capped, omitted, truncated) }],
				details: { operation: input.operation, locations: capped, omitted, truncated },
			};
		},
	};
}

export function createLspTool(cwd: string, options: LspToolOptions): AgentTool<typeof lspSchema> {
	return wrapToolDefinition(createLspToolDefinition(cwd, options));
}
