export type LspServerState = "resolved" | "starting" | "ready" | "degraded" | "disabled" | "closing" | "closed";

export interface LspStatus {
	readonly serverId: string;
	readonly root: string;
	readonly state: LspServerState;
	readonly attempt: number;
	readonly reason?: string;
}

export class LspStatusStore {
	private readonly capacity: number;
	private readonly statuses: LspStatus[] = [];
	private readonly current = new Map<string, LspStatus>();
	private _totalCount = 0;

	constructor(options?: { capacity?: number }) {
		const capacity = options?.capacity ?? 100;
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new Error("LSP status capacity must be a positive safe integer.");
		}
		this.capacity = capacity;
	}

	get totalCount(): number {
		return this._totalCount;
	}

	record(status: LspStatus): void {
		this._totalCount += 1;
		const snapshot = { ...status };
		this.statuses.push(snapshot);
		this.current.set(this.key(status.serverId, status.root), snapshot);
		if (this.statuses.length > this.capacity) this.statuses.splice(0, this.statuses.length - this.capacity);
	}

	latest(serverId: string, root: string): LspStatus | undefined {
		const status = this.current.get(this.key(serverId, root));
		return status ? { ...status } : undefined;
	}

	list(): readonly LspStatus[] {
		return this.statuses.map((status) => ({ ...status }));
	}

	private key(serverId: string, root: string): string {
		return `${serverId}\0${root}`;
	}
}
