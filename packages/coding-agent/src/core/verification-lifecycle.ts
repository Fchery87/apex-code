/**
 * VF.4: the verification lifecycle (spec
 * 2026-09-01-configured-verification-and-formatting.md § 4). The tracker
 * turns bounded executor outcomes into the five completion statuses the
 * spec names — verified, failed, unavailable, interrupted,
 * continued-unverified — and retires a result the moment the workspace it
 * described changes. It never flips failed to passed, and a stale result
 * never presents as current: the conservative rule is that ANY non-empty
 * workspace change retires the record, because proving a change irrelevant
 * is the executor's job, not the lifecycle's.
 *
 * Evidence is bounded by construction: the record carries policy identity,
 * argv, status, duration, exit/signal/truncation flags, and the artifact
 * reference — never raw output. Callers that want output read the artifact
 * through the store's permission gate.
 */

import type { PolicyRunOutcome, PolicyRunStatus } from "./policy-executor.ts";
import { runPolicyCommand } from "./policy-executor.ts";
import type { VerificationPolicy } from "./policy-loader.ts";
import type { WorkspaceArtifactRef } from "./workspace/artifacts.ts";

export type VerificationOutcome = "verified" | "failed" | "interrupted";

export type VerificationCompletionStatus =
	| "verified"
	| "failed"
	| "unavailable"
	| "interrupted"
	| "continued-unverified";

export interface VerificationEvidence {
	policyId: string;
	executable: string;
	argv: string[];
	cwd: string;
	status: PolicyRunStatus;
	durationMs: number;
	exitCode?: number;
	signal?: string;
	truncated: boolean;
	artifact?: WorkspaceArtifactRef;
}

export interface VerificationRecord {
	outcome: VerificationOutcome;
	evidence: VerificationEvidence[];
	observedAt: number;
}

export type VerificationBoundary = "explicit" | "post-turn";

export interface VerificationTrackerOptions {
	workspaceRoot: string;
}

function evidenceFor(outcome: PolicyRunOutcome): VerificationEvidence {
	return {
		policyId: outcome.policyId,
		executable: outcome.executable,
		argv: outcome.argv,
		cwd: outcome.cwd,
		status: outcome.status,
		durationMs: outcome.durationMs,
		...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
		...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
		truncated: outcome.truncated,
		...(outcome.artifact !== undefined ? { artifact: outcome.artifact } : {}),
	};
}

function recordOutcome(outcome: PolicyRunOutcome): VerificationRecord {
	const outcomeKind: VerificationOutcome =
		outcome.status === "passed" ? "verified" : outcome.status === "failed" ? "failed" : "interrupted";
	return {
		outcome: outcomeKind,
		evidence: [evidenceFor(outcome)],
		observedAt: Date.now(),
	};
}

export class VerificationTracker {
	#policies: VerificationPolicy[] = [];
	#boundary: VerificationBoundary = "explicit";
	#workspaceRoot: string;
	#latest: VerificationRecord | undefined;
	#continuedWithoutVerification = false;

	constructor(options: VerificationTrackerOptions) {
		this.#workspaceRoot = options.workspaceRoot;
	}

	configure(policies: VerificationPolicy[], boundary: VerificationBoundary): void {
		this.#policies = [...policies];
		this.#boundary = boundary;
	}

	get boundary(): VerificationBoundary {
		return this.#boundary;
	}

	policyIds(): string[] {
		return this.#policies.map((policy) => policy.id);
	}

	/**
	 * Run one configured policy by id (default: the first). Returns the new
	 * record, or undefined when the id is not configured — surfaced as
	 * "unavailable" by completionStatus(). A run retires any earlier record
	 * and any earlier continue-without-verification choice.
	 */
	async runExplicit(
		policyId?: string,
		options: { signal?: AbortSignal } = {},
	): Promise<VerificationRecord | undefined> {
		const policy =
			policyId === undefined ? this.#policies[0] : this.#policies.find((candidate) => candidate.id === policyId);
		if (policy === undefined) {
			return undefined;
		}
		this.#continuedWithoutVerification = false;
		const outcome = await runPolicyCommand(policy, { workspaceRoot: this.#workspaceRoot, signal: options.signal });
		this.#latest = recordOutcome(outcome);
		return this.#latest;
	}

	/** The user chose to finish without verification. Its own status, not a failure. */
	recordContinuedWithoutVerification(): void {
		this.#latest = undefined;
		this.#continuedWithoutVerification = true;
	}

	/**
	 * Report a workspace change observed after the latest record. Any
	 * non-empty change set retires the record: the result described a
	 * workspace that no longer exists.
	 */
	noteWorkspaceChange(changedPaths: ReadonlySet<string>): void {
		if (changedPaths.size > 0) {
			this.#latest = undefined;
		}
	}

	completionStatus(): VerificationCompletionStatus {
		if (this.#continuedWithoutVerification) {
			return "continued-unverified";
		}
		if (this.#latest === undefined) {
			return "unavailable";
		}
		return this.#latest.outcome === "verified"
			? "verified"
			: this.#latest.outcome === "failed"
				? "failed"
				: "interrupted";
	}

	/** The current record, if one is live. Stale results are not returned. */
	latest(): VerificationRecord | undefined {
		return this.#latest;
	}
}
