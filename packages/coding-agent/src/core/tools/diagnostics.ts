import type { DiagnosticEvidenceRecord, DiagnosticSeverityCounts, DiagnosticUnavailableKind } from "./contract.ts";

export type { DiagnosticEvidenceRecord, DiagnosticSeverityCounts, DiagnosticUnavailableKind } from "./contract.ts";

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
	| {
			readonly status: "ok";
			readonly serverId: string;
			readonly diagnostics: readonly Diagnostic[];
			readonly truncated: boolean;
	  }
	| {
			readonly status: "unavailable";
			readonly serverId?: string;
			readonly unavailableKind: DiagnosticUnavailableKind;
			readonly reason: string;
	  };

function emptySeverityCounts(): DiagnosticSeverityCounts {
	return { error: 0, warning: 0, information: 0, hint: 0, unspecified: 0, other: 0 };
}

/** Convert a live outcome into bounded evidence without copying server-controlled text. */
export function diagnosticEvidenceForPath(path: string, outcome: DiagnosticsOutcome): DiagnosticEvidenceRecord {
	if (outcome.status === "unavailable") {
		return {
			kind: "diagnostic",
			path,
			status: "unavailable",
			...(outcome.serverId === undefined ? {} : { serverId: outcome.serverId }),
			unavailableKind: outcome.unavailableKind,
		};
	}

	const severityCounts = emptySeverityCounts();
	for (const diagnostic of outcome.diagnostics) {
		switch (diagnostic.severity) {
			case 1:
				severityCounts.error += 1;
				break;
			case 2:
				severityCounts.warning += 1;
				break;
			case 3:
				severityCounts.information += 1;
				break;
			case 4:
				severityCounts.hint += 1;
				break;
			case undefined:
				severityCounts.unspecified += 1;
				break;
			default:
				severityCounts.other += 1;
		}
	}
	return {
		kind: "diagnostic",
		path,
		status: "ok",
		serverId: outcome.serverId,
		diagnosticCount: outcome.diagnostics.length,
		severityCounts,
		truncated: outcome.truncated,
	};
}

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
