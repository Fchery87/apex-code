import type { SessionManager } from "./session-manager.ts";
import type { EvidenceCaptureDiagnostic, EvidenceRecord, EvidenceSink } from "./tools/contract.ts";

const CREDENTIAL_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|password|secret)/i;

function assertSafeValue(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertSafeValue(item);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (CREDENTIAL_KEY.test(key)) {
			throw new Error(`Evidence contains credential-shaped key: ${key}`);
		}
		assertSafeValue(child);
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
		this.#sessionManager.appendEvidence(entry.toolName, entry.records);
	}

	recordDiagnostic(diagnostic: EvidenceCaptureDiagnostic): void {
		this.#sessionManager.appendEvidenceDiagnostic(diagnostic);
	}
}
