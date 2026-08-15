import type { SessionManager } from "./session-manager.ts";
import type { EvidenceCaptureDiagnostic, EvidenceRecord, EvidenceSink } from "./tools/contract.ts";

const CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|password|secret)/i;

const MAX_FACT_BYTES = 16_384;
const RAW_CONTENT_KEY = /^(?:content|output|stdout|stderr|patch|body|text)$/i;
const ARTIFACT_KEY = /(?:artifact|outputPath|fullOutputPath)/i;

function assertSafeValue(value: unknown, key?: string): void {
	if (key && RAW_CONTENT_KEY.test(key)) {
		throw new Error(`Evidence contains raw content: ${key}`);
	}
	if (Array.isArray(value)) {
		for (const item of value) assertSafeValue(item);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [childKey, child] of Object.entries(value)) {
		if (CREDENTIAL_KEY.test(childKey)) {
			throw new Error(`Evidence contains credential-shaped key: ${childKey}`);
		}
		if (
			ARTIFACT_KEY.test(childKey) &&
			typeof child === "string" &&
			(child.startsWith("/") || child.split(/[\\/]+/).includes(".."))
		) {
			throw new Error(`Evidence contains unsafe artifact reference: ${child}`);
		}
		assertSafeValue(child, childKey);
	}
}

function assertBounded(records: EvidenceRecord[]): void {
	if (Buffer.byteLength(JSON.stringify(records), "utf8") > MAX_FACT_BYTES) {
		throw new Error(`Evidence facts must remain bounded at ${MAX_FACT_BYTES} bytes`);
	}
}

/**
 * Durable JSONL evidence sink. It validates the secret boundary before appending
 * source facts; policy evaluation intentionally remains outside core.
 */
export class SessionEvidenceSink implements EvidenceSink {
	readonly #sessionManager: SessionManager;

	constructor(sessionManager: SessionManager) {
		this.#sessionManager = sessionManager;
	}

	record(entry: { toolName: string; records: EvidenceRecord[] }): void {
		assertSafeValue(entry.records);
		assertBounded(entry.records);
		this.#sessionManager.appendEvidence(entry.toolName, entry.records);
	}

	recordDiagnostic(diagnostic: EvidenceCaptureDiagnostic): void {
		this.#sessionManager.appendEvidenceDiagnostic(diagnostic);
	}
}
