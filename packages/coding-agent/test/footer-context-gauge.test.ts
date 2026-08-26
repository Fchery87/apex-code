import { describe, expect, it } from "vitest";
import { renderContextGauge } from "../src/modes/interactive/components/footer.ts";

describe("renderContextGauge", () => {
	it("always spans exactly eight cells", () => {
		for (const percent of [0, 1, 4, 12.3, 50, 75, 88, 99.9, 100]) {
			const gauge = renderContextGauge(percent, "unicode");
			expect(gauge.filled.length + gauge.empty.length, `percent ${percent}`).toBe(8);
		}
	});

	it("leaves the track empty at zero and fills it at a hundred", () => {
		expect(renderContextGauge(0, "unicode")).toEqual({ filled: "", empty: "░".repeat(8) });
		expect(renderContextGauge(100, "unicode")).toEqual({ filled: "█".repeat(8), empty: "" });
	});

	it("lights one cell for any non-zero usage", () => {
		// Rounding 1% to zero cells would show an empty bar while the window is
		// genuinely filling, which reads as "nothing used".
		for (const percent of [0.1, 1, 5]) {
			expect(renderContextGauge(percent, "unicode").filled, `percent ${percent}`).toBe("█");
		}
	});

	it("grows monotonically", () => {
		let previous = -1;
		for (let percent = 0; percent <= 100; percent++) {
			const filled = renderContextGauge(percent, "unicode").filled.length;
			expect(filled, `percent ${percent}`).toBeGreaterThanOrEqual(previous);
			previous = filled;
		}
	});

	it("shows an empty track when the percentage is unknown", () => {
		// After compaction the token count is unknown until the next response.
		// An empty track is honest; a guessed position is not.
		expect(renderContextGauge(undefined, "unicode")).toEqual({ filled: "", empty: "░".repeat(8) });
	});

	it("clamps out-of-range input rather than overflowing the tray", () => {
		expect(renderContextGauge(140, "unicode").filled).toHaveLength(8);
		expect(renderContextGauge(-20, "unicode").filled).toHaveLength(0);
	});

	it("uses no block glyphs under the ascii preset", () => {
		const gauge = renderContextGauge(50, "ascii");
		expect(gauge.filled + gauge.empty).toBe("####----");
	});
});
