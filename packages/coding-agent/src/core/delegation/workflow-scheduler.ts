export const DEFAULT_WORKFLOW_CONCURRENCY = 4;
export const WORKFLOW_ATTEMPT_LIMIT = 100;
export const WORKFLOW_DEADLINE_MS = 60 * 60 * 1000;

interface QueuedTask {
	readonly run: () => Promise<void>;
	readonly cancel: (reason: Error) => void;
}

export interface WorkflowSchedulerOptions {
	readonly concurrency?: number;
	readonly maxAttempts?: number;
	readonly signal?: AbortSignal;
}

export class WorkflowScheduler {
	private readonly queue: QueuedTask[] = [];
	private active = 0;
	private attempts = 0;
	private stopped = false;
	private readonly concurrency: number;
	private readonly maxAttempts: number;
	private readonly onAbort: () => void;

	constructor(options: WorkflowSchedulerOptions = {}) {
		const requested = options.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY;
		if (!Number.isInteger(requested) || requested < 1)
			throw new Error("Workflow concurrency must be a positive integer.");
		const attempts = options.maxAttempts ?? WORKFLOW_ATTEMPT_LIMIT;
		if (!Number.isInteger(attempts) || attempts < 1)
			throw new Error("Workflow attempt limit must be a positive integer.");
		this.concurrency = requested;
		this.maxAttempts = attempts;
		this.onAbort = () => {
			this.stopped = true;
			const error = new Error("Workflow cancelled before queued steps were admitted.");
			while (this.queue.length > 0) this.queue.shift()?.cancel(error);
		};
		if (options.signal?.aborted) this.onAbort();
		else options.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	get activeCount(): number {
		return this.active;
	}
	get admittedAttempts(): number {
		return this.attempts;
	}

	schedule<T>(run: () => Promise<T>): Promise<T> {
		if (this.stopped) return Promise.reject(new Error("Workflow scheduler is cancelled."));
		if (this.attempts + this.queue.length >= this.maxAttempts) {
			return Promise.reject(new Error(`Workflow attempt limit ${this.maxAttempts} was reached.`));
		}
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				run: async () => {
					try {
						resolve(await run());
					} catch (error) {
						reject(error);
					}
				},
				cancel: reject,
			});
			this.pump();
		});
	}

	async drain(): Promise<void> {
		while (this.active > 0 || this.queue.length > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}

	private pump(): void {
		while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
			const task = this.queue.shift();
			if (!task) return;
			this.active += 1;
			this.attempts += 1;
			void task.run().finally(() => {
				this.active -= 1;
				this.pump();
			});
		}
	}
}
