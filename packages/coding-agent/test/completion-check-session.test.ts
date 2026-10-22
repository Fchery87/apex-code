import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./test-harness.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("completion check after a user turn", () => {
	it("queues one follow-up when the configured policy fails", async () => {
		const harness = await createHarness({ responses: ["done"] });
		cleanups.push(harness.cleanup);
		let calls = 0;
		harness.session.requestVerification = async () => {
			calls += 1;
			return "failed";
		};
		harness.session.setCompletionCondition({ policyId: "typecheck", maxTurns: 1 });

		await harness.session.prompt("run the check");

		expect(calls).toBe(2);
		expect(harness.session.getCompletionCondition()).toBeUndefined();
	});

	it("does not queue a follow-up when no condition is set", async () => {
		const harness = await createHarness({ responses: ["done"] });
		cleanups.push(harness.cleanup);

		await harness.session.prompt("just answer");

		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});
});
