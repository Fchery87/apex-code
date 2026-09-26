import { describe, expect, it } from "vitest";
import { summarizeError } from "../src/modes/interactive/components/error-summary.ts";

describe("summarizeError", () => {
	it("has nothing to fold in a one-line error", () => {
		expect(summarizeError("rate limited")).toBeUndefined();
		expect(summarizeError("rate limited\n\n  ")).toBeUndefined();
	});

	it("leads with the first line of a multi-line error", () => {
		expect(summarizeError('\n400 invalid request\n{\n  "type": "error"\n}')).toBe("400 invalid request");
	});

	it("names the raised error, not the frame, for a Python traceback", () => {
		const traceback = [
			"Traceback (most recent call last):",
			'  File "main.py", line 3, in <module>',
			"    run()",
			"ValueError: bad input",
		].join("\n");
		expect(summarizeError(traceback)).toBe("ValueError: bad input");
	});

	it("reads carriage returns as line breaks", () => {
		expect(summarizeError("first\r\nsecond")).toBe("first");
	});
});
