import { describe, expect, test } from "vitest";
import type { SourceInfo } from "../src/core/source-info.ts";
import { describeWithSource } from "../src/modes/interactive/components/autocomplete-source.ts";

function source(scope: SourceInfo["scope"], from: string): SourceInfo {
	return { scope, source: from, path: "/tmp/x", origin: "top-level" } as unknown as SourceInfo;
}

describe("describeWithSource", () => {
	test("adds nothing for a skill or command the user or project wrote", () => {
		expect(describeWithSource("Review the diff", source("user", "local"))).toBe("Review the diff");
		expect(describeWithSource("Review the diff", source("project", "auto"))).toBe("Review the diff");
	});

	test("names the package a resource came from", () => {
		expect(describeWithSource("Deploy", source("user", "npm:@acme/skills"))).toBe("[npm:@acme/skills] Deploy");
		expect(describeWithSource(undefined, source("project", "npm:tools"))).toBe("[npm:tools]");
	});
});
