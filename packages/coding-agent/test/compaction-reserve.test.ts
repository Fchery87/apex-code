import { describe, expect, it } from "vitest";
import { effectiveReserveTokens, shouldCompact } from "../src/core/compaction/compaction.ts";

const settings = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

describe("compaction reserve follows the output limit, capped at a share of the window (HR.29, Q6)", () => {
	it("reserves the output limit when it is a modest share of a large window", () => {
		expect(effectiveReserveTokens(settings, 20000, 200000)).toBe(20000);
	});

	it("caps the output-limit floor at a third of the window by default", () => {
		// A 128k output limit would take most of a 200k window; the floor is capped at 200000 / 3.
		expect(effectiveReserveTokens(settings, 128000, 200000)).toBe(Math.floor(200000 / 3));
	});

	it("keeps the configured reserve when the output limit is smaller", () => {
		expect(effectiveReserveTokens(settings, 4096, 200000)).toBe(16384);
	});

	it("keeps the configured reserve when the model declares no output limit", () => {
		expect(effectiveReserveTokens(settings, undefined, 200000)).toBe(16384);
	});

	it("uses a configured fraction instead of a third", () => {
		const half = { ...settings, outputReserveFraction: 0.5 };
		expect(effectiveReserveTokens(half, 128000, 200000)).toBe(100000);
	});

	it("a large-output model compacts earlier than the fixed reserve would allow, but not at the cap", () => {
		expect(shouldCompact(80000, 200000, settings)).toBe(false);
		expect(shouldCompact(120000, 200000, settings, 128000)).toBe(false);
		expect(shouldCompact(140000, 200000, settings, 128000)).toBe(true);
	});
});
