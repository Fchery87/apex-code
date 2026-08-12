export type SandboxViolationKind = "filesystem" | "network" | "unknown";

export interface SandboxViolation {
	readonly kind: SandboxViolationKind;
	readonly command: string;
	readonly detail: string;
	readonly timestamp: Date;
}

/**
 * Apex-owned bounded violation tail. It intentionally does not depend on a platform
 * runtime's monitor, because Linux does not provide that monitor consistently.
 */
export class SandboxViolationStore {
	private readonly capacity: number;
	private readonly violations: SandboxViolation[] = [];
	private _totalCount = 0;

	constructor(options?: { capacity?: number }) {
		const capacity = options?.capacity ?? 100;
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new Error("Sandbox violation capacity must be a positive safe integer.");
		}
		this.capacity = capacity;
	}

	get totalCount(): number {
		return this._totalCount;
	}

	add(violation: SandboxViolation): void {
		this._totalCount += 1;
		this.violations.push(violation);
		if (this.violations.length > this.capacity) {
			this.violations.splice(0, this.violations.length - this.capacity);
		}
	}

	list(): readonly SandboxViolation[] {
		return [...this.violations];
	}
}
