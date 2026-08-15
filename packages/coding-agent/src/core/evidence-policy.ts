import type { ExtensionFactory } from "./extensions/types.ts";
import type { DurableEvidenceRecord } from "./session-manager.ts";

export interface EvidencePolicyInput {
	toolName: string;
	toolCallId: string;
	isError: boolean;
	records: readonly DurableEvidenceRecord[];
}

/**
 * Optional policy-consumption adapter. It receives an immutable snapshot after
 * core has durably captured source facts, and deliberately returns no tool-result
 * patch: policy may report or gate at its own extension boundary, never alter
 * capture or core execution semantics.
 */
export type EvidencePolicy = (input: EvidencePolicyInput) => void | Promise<void>;

function freezeRecursively(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) freezeRecursively(child);
}

function evidenceSnapshot(records: readonly DurableEvidenceRecord[]): readonly DurableEvidenceRecord[] {
	const snapshot = structuredClone(records);
	freezeRecursively(snapshot);
	return snapshot;
}

export function createEvidencePolicyExtension(policy: EvidencePolicy): ExtensionFactory {
	return (pi) => {
		pi.on("tool_result", async (event, ctx) => {
			await policy({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
				records: evidenceSnapshot(ctx.sessionManager.getEvidenceRecords()),
			});
		});
	};
}
