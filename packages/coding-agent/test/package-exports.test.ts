import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
	exports: Record<string, Record<string, string>>;
};

describe("published package exports (HR.26)", () => {
	it.each(Object.entries(pkg.exports))("%s resolves through a published condition, not source", (_subpath, target) => {
		expect(target).not.toHaveProperty("source");
		expect(target).toHaveProperty("import");
	});

	it("exports no subpath that points only into the unpublished source tree", () => {
		expect(Object.keys(pkg.exports)).toEqual([".", "./rpc-entry"]);
	});
});
