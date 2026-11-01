import { describe, expect, it } from "vitest";
import { WorkflowScheduler } from "../../src/core/delegation/workflow-scheduler.ts";

describe("workflow scheduler", () => {
	it("limits active work and preserves all results", async () => {
		let active = 0;
		let peak = 0;
		const scheduler = new WorkflowScheduler({ concurrency: 2 });
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				scheduler.schedule(async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active -= 1;
					return index;
				}),
			),
		);
		expect(results).toEqual([0, 1, 2, 3, 4]);
		expect(peak).toBe(2);
		expect(scheduler.admittedAttempts).toBe(5);
	});
	it("refuses the 101st attempt before starting it", async () => {
		const scheduler = new WorkflowScheduler({ concurrency: 4, maxAttempts: 100 });
		const tasks = Array.from({ length: 101 }, () => scheduler.schedule(async () => 1));
		await expect(Promise.all(tasks)).rejects.toThrow(/100/);
		await scheduler.drain();
		expect(scheduler.admittedAttempts).toBe(100);
	});
	it("rejects queued work after cancellation", async () => {
		const controller = new AbortController();
		const scheduler = new WorkflowScheduler({ concurrency: 1, signal: controller.signal });
		let release!: () => void;
		const running = scheduler.schedule(
			() =>
				new Promise<number>((resolve) => {
					release = () => resolve(1);
				}),
		);
		const queued = scheduler.schedule(async () => 2);
		controller.abort();
		release();
		await expect(queued).rejects.toThrow(/cancel/i);
		await expect(running).resolves.toBe(1);
	});
});
