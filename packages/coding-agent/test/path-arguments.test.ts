import { describe, expect, it } from "vitest";
import { acceptFilePathAlias } from "../src/core/tools/path-arguments.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

describe("file_path alias", () => {
	it("renames file_path to path and leaves a real path alone", () => {
		expect(acceptFilePathAlias({ file_path: "README.md", offset: 1 })).toEqual({ path: "README.md", offset: 1 });
		const own = { path: "README.md", file_path: "other.md" };
		expect(acceptFilePathAlias(own)).toBe(own);
		expect(acceptFilePathAlias(null)).toBe(null);
	});

	it("is what the read tool prepares before validation", () => {
		const definition = createReadToolDefinition(process.cwd());
		expect(definition.prepareArguments?.({ file_path: "README.md", limit: 10 })).toEqual({
			path: "README.md",
			limit: 10,
		});
	});
});
