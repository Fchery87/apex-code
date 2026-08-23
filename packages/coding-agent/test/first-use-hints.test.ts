import { describe, expect, it } from "vitest";
import { FirstUseHints } from "../src/modes/interactive/components/first-use-hints.ts";

describe("FirstUseHints", () => {
	it("offers each relevant hint once and ignores unknown persisted values", () => {
		const hints = new FirstUseHints(["queue", "future-hint"]);
		expect(hints.offer("queue")).toBeUndefined();
		expect(hints.offer("bash")).toContain("Escape");
		expect(hints.offer("bash")).toBeUndefined();
		expect(hints.getSeen()).toEqual(["queue", "bash"]);
	});
});
