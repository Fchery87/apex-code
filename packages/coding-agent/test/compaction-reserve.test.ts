import { describe, expect, it } from "vitest";
import { effectiveReserveTokens, shouldCompact } from "../src/core/compaction/compaction.ts";

const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

describe("compaction reserve follows the model's output limit (HR.29)", () => {
	it("reserves at least the model's maximum output", () => {
		expect(effectiveReserveTokens(settings, 128000)).toBe(128000);
	});

	it("keeps the configured reserve when the output limit is smaller", () => {
		expect(effectiveReserveTokens(settings, 4096)).toBe(16384);
	});

	it("keeps the configured reserve when the model declares no output limit", () => {
		expect(effectiveReserveTokens(settings, undefined)).toBe(16384);
	});

	it("a large-output model compacts earlier than the fixed reserve would allow", () => {
		// 200k window. With the 16k reserve, 80k used is far from the limit: no compaction.
		expect(shouldCompact(80000, 200000, settings)).toBe(false);
		// With a 128k output limit, the next response needs 128k, so 80k used is past the line.
		expect(shouldCompact(80000, 200000, settings, 128000)).toBe(true);
	});
});
