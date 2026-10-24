import { describe, expect, it } from "vitest";
import { compactionFacts } from "../src/core/compaction/facts.ts";

describe("compaction facts", () => {
	it("includes a last failure even when git has no diff", async () => {
		const text = await compactionFacts("/tmp", { command: "npm test", exitCode: 1 });
		expect(text).toContain('command="npm test"');
		expect(text).toContain('exit="1"');
	});

	it("is empty when there is no failure and no repository diff", async () => {
		const text = await compactionFacts("/tmp");
		expect(text === "" || text.includes("<git-diff-stat>")).toBe(true);
	});
});
