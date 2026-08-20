/** A zero-based position reported by a language server. */
export interface DiagnosticPosition {
	readonly line: number;
	readonly character: number;
}

export interface DiagnosticRange {
	readonly start: DiagnosticPosition;
	readonly end: DiagnosticPosition;
}

/** The tool-local diagnostic shape consumed by mutation tools. */
export interface Diagnostic {
	readonly range: DiagnosticRange;
	readonly severity?: number;
	readonly code?: string | number;
	readonly source?: string;
	readonly message: string;
}

export type DiagnosticsOutcome =
	| { readonly status: "ok"; readonly diagnostics: readonly Diagnostic[] }
	| { readonly status: "unavailable"; readonly reason: string };

/** Optional diagnostics integration for a successful file mutation. */
export interface DiagnosticsOperations {
	afterMutation(absolutePath: string, signal?: AbortSignal): Promise<DiagnosticsOutcome>;
}

function diagnosticLabel(diagnostic: Diagnostic): string {
	const origin = [diagnostic.source, diagnostic.code].filter((part) => part !== undefined).join(":");
	return origin ? ` [${origin}]` : "";
}

/** Deterministic text appended to the mutation result seen by the model. */
export function formatDiagnosticsOutcome(outcome: DiagnosticsOutcome): string {
	if (outcome.status === "unavailable") return `Diagnostics unavailable: ${outcome.reason}`;
	if (outcome.diagnostics.length === 0) return "Diagnostics: clean";
	return [
		"Diagnostics:",
		...outcome.diagnostics.map(
			(diagnostic) =>
				`- ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}${diagnosticLabel(diagnostic)} ${diagnostic.message}`,
		),
	].join("\n");
}
