import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLspToolDefinition, type LspOperations } from "../../src/core/tools/lsp.ts";

const workspaces: string[] = [];

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<{ cwd: string; path: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "apex-lsp-tool-"));
	workspaces.push(cwd);
	const path = join(cwd, "src", "space name.ts");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(join(cwd, "src"), { recursive: true }));
	await writeFile(path, "export const value = 1;\n", "utf8");
	return { cwd, path };
}

async function execute(cwd: string, operations: LspOperations, input: Record<string, unknown>) {
	// Calling the (unwrapped) ApexToolDefinition directly, rather than through
	// wrapToolDefinition()'s AgentTool -- whose trailing params are optional -- so
	// the full 5-arg ToolDefinition.execute signature is passed explicitly here.
	return createLspToolDefinition(cwd, { operations }).execute(
		"call",
		input as never,
		undefined,
		undefined,
		undefined as never,
	);
}

describe("lsp navigation tool", () => {
	it("converts the one-based UTF-16 seam to zero-based LSP positions and normalizes locations", async () => {
		const { cwd, path } = await workspace();
		const seen: Array<{ method: string; params: unknown }> = [];
		const operations: LspOperations = {
			request: async (absolutePath, method, params) => {
				expect(absolutePath).toBe(path);
				seen.push({ method, params });
				return [
					{
						uri: "https://example.test/not-a-file",
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					},
					{
						uri: pathToFileURL(path).href,
						range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
					},
				];
			},
		};

		const result = await execute(cwd, operations, {
			operation: "definition",
			path: "src/space name.ts",
			line: 3,
			character: 5,
		});
		expect(seen).toEqual([
			{
				method: "textDocument/definition",
				params: {
					textDocument: { uri: pathToFileURL(path).href },
					position: { line: 2, character: 4 },
				},
			},
		]);
		expect(result.details).toEqual({
			operation: "definition",
			locations: [
				{ path: "src/space name.ts", range: { start: { line: 3, character: 5 }, end: { line: 3, character: 10 } } },
			],
			omitted: 1,
			truncated: 0,
		});
	});

	it("deduplicates and deterministically sorts references before applying the 1,000-location cap", async () => {
		const { cwd, path } = await workspace();
		const uri = pathToFileURL(path).href;
		const locations = Array.from({ length: 1_005 }, (_, index) => ({
			uri,
			range: { start: { line: 1_004 - index, character: 0 }, end: { line: 1_004 - index, character: 1 } },
		}));
		locations.push(locations[0]);
		const operations: LspOperations = { request: async () => locations };
		const result = await execute(cwd, operations, { operation: "references", path, line: 1, character: 1 });
		if (result.details?.operation !== "references") throw new Error("Expected reference details");
		expect(result.details.locations).toHaveLength(1_000);
		expect(result.details.locations[0]?.range.start.line).toBe(1);
		expect(result.details.locations[999]?.range.start.line).toBe(1_000);
		expect(result.details.truncated).toBe(5);
		expect(result.details.omitted).toBe(0);
	});

	it("flattens document symbols deterministically and caps them at 2,000", async () => {
		const { cwd, path } = await workspace();
		const symbols = Array.from({ length: 2_005 }, (_, index) => ({
			name: `symbol-${String(2_004 - index).padStart(4, "0")}`,
			kind: 12,
			range: { start: { line: 2_004 - index, character: 0 }, end: { line: 2_004 - index, character: 2 } },
			selectionRange: { start: { line: 2_004 - index, character: 0 }, end: { line: 2_004 - index, character: 1 } },
		}));
		const result = await execute(cwd, { request: async () => symbols }, { operation: "document_symbols", path });
		if (result.details?.operation !== "document_symbols") throw new Error("Expected symbol details");
		expect(result.details.symbols).toHaveLength(2_000);
		expect(result.details.symbols[0]).toMatchObject({ name: "symbol-0000", path: "src/space name.ts" });
		expect(result.details.truncated).toBe(5);
		expect(result.details.omitted).toBe(0);
	});

	it("declares the deferred read-only contract and path permission grammar", async () => {
		const { cwd } = await workspace();
		const definition = createLspToolDefinition(cwd, { operations: { request: async () => [] } });
		const call = { operation: "definition" as const, path: "src/space name.ts", line: 1, character: 1 };
		const rule = definition.contract.permission.ruleForCall(call);
		expect([...definition.contract.capabilities]).toEqual(["fs.read"]);
		expect(definition.contract.permission.defaultBehavior).toBe("allow");
		expect(definition.contract.context).toMatchObject({ resultRecoverable: true, deferSchema: true });
		expect(rule).toBe("src/space name.ts");
		expect(definition.contract.permission.matches(rule!, call)).toBe(true);
		expect(definition.contract.permission.matches(rule!, { ...call, path: "src/other.ts" })).toBe(false);
	});
});
