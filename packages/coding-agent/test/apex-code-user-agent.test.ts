import { describe, expect, it } from "vitest";
import { getApexCodeUserAgent } from "../src/utils/apex-code-user-agent.ts";

describe("getApexCodeUserAgent", () => {
	it("formats a self-identifying user agent for outbound requests", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getApexCodeUserAgent("1.2.3");

		expect(userAgent).toBe(`apex-code/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^apex-code\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
