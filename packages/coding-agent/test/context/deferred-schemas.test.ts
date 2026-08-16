import { describe, expect, it } from "vitest";
import {
	type AnnouncedTool,
	announceToolsByName,
	type DeferrableTool,
	loadDeferredSchema,
} from "../../src/core/context/deferred-schemas.ts";
import { projectToolSchemas } from "../../src/core/context/pipeline.ts";

/**
 * Hand-written, hermetic fixtures shaped like `ApexToolDefinition` — name,
 * description, a plausible JSON-schema-shaped `parameters` object, and a
 * `contract.context.deferSchema` flag. Deliberately not pulled from the real tool
 * registry (`core/tools/index.ts`), per this task's scope: this module must stay pure
 * and testable without a live registry.
 */

const SEARCH_CODEBASE_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Regex or literal pattern to search for." },
		path: { type: "string", description: "Directory or file to scope the search to." },
		maxResults: { type: "number", description: "Cap on the number of matches returned." },
		caseSensitive: { type: "boolean", description: "Whether matching is case-sensitive." },
		includeGlobs: {
			type: "array",
			items: { type: "string" },
			description: "Glob patterns limiting which files are searched.",
		},
	},
	required: ["query"],
} as const;

const READ_FILE_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path of the file to read." },
	},
	required: ["path"],
} as const;

const deferredTool: DeferrableTool = {
	name: "search_codebase",
	description: "Search the codebase for a pattern across files.",
	parameters: SEARCH_CODEBASE_SCHEMA,
	contract: { context: { deferSchema: true } },
};

const nonDeferredTool: DeferrableTool = {
	name: "read_file",
	description: "Read a file's contents.",
	parameters: READ_FILE_SCHEMA,
	contract: { context: { deferSchema: false } },
};

describe("announceToolsByName", () => {
	it("announces a deferSchema:true tool without its parameter schema", () => {
		const [announced] = announceToolsByName([deferredTool]);

		expect(announced.name).toBe("search_codebase");
		expect(announced.description).toBe(deferredTool.description);
		// The full schema's properties/required must not leak into the announced form.
		expect(announced.parameters).not.toEqual(SEARCH_CODEBASE_SCHEMA);
		expect(JSON.stringify(announced.parameters)).not.toContain("query");
		expect(JSON.stringify(announced.parameters)).not.toContain("includeGlobs");
		expect(JSON.stringify(announced.parameters)).not.toContain("caseSensitive");
	});

	it("passes a deferSchema:false tool through unchanged", () => {
		const [announced] = announceToolsByName([nonDeferredTool]);

		expect(announced.name).toBe("read_file");
		expect(announced.description).toBe(nonDeferredTool.description);
		expect(announced.parameters).toEqual(READ_FILE_SCHEMA);
	});

	it("does not defer everything — mixed input keeps each tool's own treatment", () => {
		const projected = announceToolsByName([deferredTool, nonDeferredTool]);
		const [deferred, plain] = projected as [AnnouncedTool, AnnouncedTool];

		expect(deferred.parameters).not.toEqual(SEARCH_CODEBASE_SCHEMA);
		expect(plain.parameters).toEqual(READ_FILE_SCHEMA);
	});

	it("shrinks the static prefix when at least one tool defers its schema", () => {
		const tools: DeferrableTool[] = [deferredTool, nonDeferredTool];

		const projectedSize = JSON.stringify(announceToolsByName(tools)).length;
		const fullSize = JSON.stringify(
			tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		).length;

		expect(projectedSize).toBeLessThan(fullSize);
	});
});

describe("loadDeferredSchema", () => {
	it("materializes the real, original schema for a deferred tool", () => {
		const loaded = loadDeferredSchema([deferredTool], "search_codebase");
		expect(loaded).toEqual(SEARCH_CODEBASE_SCHEMA);
	});

	it("throws clearly when the tool name is not found", () => {
		expect(() => loadDeferredSchema([deferredTool], "does_not_exist")).toThrow(/does_not_exist/);
	});
});

describe("projectToolSchemas", () => {
	it("keeps an unclassified foreign tool's real schema announced through the canonical fallback", () => {
		const [projected] = projectToolSchemas(
			[{ name: "foreign_search", description: "A third-party search tool", parameters: SEARCH_CODEBASE_SCHEMA }],
			() => undefined,
		);
		expect(projected?.parameters).toEqual(SEARCH_CODEBASE_SCHEMA);
	});
});
