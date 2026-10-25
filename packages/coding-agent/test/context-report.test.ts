import { describe, expect, it } from "vitest";
import { contextReport } from "../src/modes/interactive/context-report.ts";

const stats = {
	tokens: { input: 250, output: 10, cacheRead: 750, cacheWrite: 0, total: 1010 },
	cost: 0.125,
};

describe("context report", () => {
	it("states the window used, the cache rate, and the cost", () => {
		const report = contextReport({
			usage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
			stats,
		});
		expect(report).toContain("1,000 of 200,000");
		expect(report).toContain("75.0%");
		expect(report).toContain("$0.125");
		expect(report).not.toContain("File:");
	});

	it("says when the window is unknown", () => {
		const report = contextReport({ usage: { tokens: null, contextWindow: 200000, percent: null }, stats });
		expect(report).toContain("unknown");
	});
});
