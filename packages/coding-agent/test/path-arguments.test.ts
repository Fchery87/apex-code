import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { acceptFilePathAlias } from "../src/core/tools/path-arguments.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

describe("file_path alias", () => {
	it("renames file_path to path and leaves a real path alone", () => {
		expect(acceptFilePathAlias({ file_path: "README.md", offset: 1 })).toEqual({ path: "README.md", offset: 1 });
		const own = { path: "README.md", file_path: "other.md" };
		expect(acceptFilePathAlias(own)).toBe(own);
		expect(acceptFilePathAlias(null)).toBe(null);
	});

	it.each([
		["read", createReadToolDefinition],
		["write", createWriteToolDefinition],
		["edit", createEditToolDefinition],
		["grep", createGrepToolDefinition],
		["find", createFindToolDefinition],
		["ls", createLsToolDefinition],
	] as const)("renames file_path before %s validates its arguments", (_name, create) => {
		const definition = create(process.cwd());
		expect(definition.prepareArguments?.({ file_path: "README.md" })).toMatchObject({ path: "README.md" });
	});
});
