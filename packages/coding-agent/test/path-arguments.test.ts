import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { acceptFilePathAlias } from "../src/core/tools/path-arguments.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tools = [
	["read", createReadToolDefinition],
	["write", createWriteToolDefinition],
	["edit", createEditToolDefinition],
	["grep", createGrepToolDefinition],
	["find", createFindToolDefinition],
	["ls", createLsToolDefinition],
] as const;

const aliases = ["file_path", "filePath", "filepath", "directory", "dir"] as const;

describe("path argument aliases", () => {
	it("copies the first alias into path and leaves a set path alone", () => {
		expect(acceptFilePathAlias({ file_path: "README.md", offset: 1 })).toEqual({
			file_path: "README.md",
			offset: 1,
			path: "README.md",
		});
		const own = { path: "README.md", file_path: "other.md" };
		expect(acceptFilePathAlias(own)).toBe(own);
		expect(acceptFilePathAlias(null)).toBe(null);
		expect(acceptFilePathAlias({ pattern: "*.ts" })).toEqual({ pattern: "*.ts" });
	});

	it.each(tools)("prepares %s from every path alias", (_name, create) => {
		const definition = create(process.cwd());
		for (const alias of aliases) {
			expect(definition.prepareArguments?.({ [alias]: "README.md" })).toMatchObject({ path: "README.md" });
		}
	});
});
