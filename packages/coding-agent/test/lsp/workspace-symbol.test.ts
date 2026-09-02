import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createLspToolDefinition, type LspOperations } from "../../src/core/tools/lsp.ts";

/**
 * Public-boundary tests for the permission-safe `workspace_symbol` operation
 * (TR.6, spec 2026-09-01-tool-reliability-and-execution-budgets.md § 4). One
 * operation on the existing `lsp` tool — never a second tool or a second
 * classifier — with workspace-root authorization before the request,
 * normalized results, explicit caps, and honest counts.
 */

const workspaces: string[] = [];

afterEach(async () => {
	await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<{ cwd: string; path: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "apex-lsp-workspace-symbol-"));
	workspaces.push(cwd);
	await mkdir(join(cwd, "src"), { recursive: true });
	const path = join(cwd, "src", "main.ts");
	await writeFile(path, "export const value = 1;\n", "utf8");
	return { cwd, path };
}

async function execute(cwd: string, operations: LspOperations, input: Record<string, unknown>) {
	return createLspToolDefinition(cwd, { operations }).execute(
		"call",
		input as never,
		undefined,
		undefined,
		undefined as never,
	);
}

function symbolInformation(name: string, path: string, line = 0, containerName?: string) {
	return {
		name,
		kind: 12,
		...(containerName ? { containerName } : {}),
		location: {
			uri: pathToFileURL(path).href,
			range: { start: { line, character: 2 }, end: { line, character: 9 } },
		},
	};
}

describe("lsp workspace_symbol operation", () => {
	it("sends workspace/symbol with the query and normalizes results to relative paths and one-based ranges", async () => {
		const { cwd, path } = await workspace();
		const seen: Array<{ path: string; method: string; params: unknown }> = [];
		const operations: LspOperations = {
			request: async (requestPath, method, params) => {
				seen.push({ path: requestPath, method, params });
				return [symbolInformation("makeThing", path, 4, "factory")];
			},
		};

		const result = await execute(cwd, operations, { operation: "workspace_symbol", query: "makeThing" });

		expect(seen).toEqual([{ path: cwd, method: "workspace/symbol", params: { query: "makeThing" } }]);
		expect(result.details).toEqual({
			operation: "workspace_symbol",
			symbols: [
				{
					name: "makeThing",
					kind: 12,
					containerName: "factory",
					path: "src/main.ts",
					range: { start: { line: 5, character: 3 }, end: { line: 5, character: 10 } },
				},
			],
			omitted: 0,
			outsideRoot: 0,
			truncated: 0,
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: "src/main.ts:5:3 makeThing" });
	});

	it("reports an empty response without erroring", async () => {
		const { cwd } = await workspace();
		const result = await execute(
			cwd,
			{ request: async () => [] },
			{ operation: "workspace_symbol", query: "nothing" },
		);

		expect(result.content[0]).toMatchObject({ type: "text", text: "No symbols found." });
		expect(result.details).toMatchObject({ operation: "workspace_symbol", symbols: [], omitted: 0, truncated: 0 });
	});

	it("counts malformed items honestly as omitted", async () => {
		const { cwd, path } = await workspace();
		const operations: LspOperations = {
			request: async () => [
				symbolInformation("good", path),
				{ name: 42, location: { uri: pathToFileURL(path).href, range: {} } },
				{ name: "no-location" },
				"https://not-a-file-uri",
			],
		};
		const result = await execute(cwd, operations, { operation: "workspace_symbol", query: "x" });

		expect(result.details).toMatchObject({ operation: "workspace_symbol", omitted: 3, truncated: 0 });
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("3 non-file result(s) omitted"),
		});
	});

	it("omits results outside the authorized workspace root and reports the count", async () => {
		const { cwd, path } = await workspace();
		const outsideFile = join(await mkdtemp(join(tmpdir(), "apex-lsp-outside-")), "leak.ts");
		await writeFile(outsideFile, "export const secret = 1;\n", "utf8");
		const operations: LspOperations = {
			request: async () => [symbolInformation("inside", path), symbolInformation("outside", outsideFile)],
		};
		const result = await execute(cwd, operations, { operation: "workspace_symbol", query: "x" });

		expect(result.details).toMatchObject({ operation: "workspace_symbol", outsideRoot: 1 });
		const details = result.details as { symbols: Array<{ name: string; path: string }> };
		expect(details.symbols).toHaveLength(1);
		expect(details.symbols[0]?.name).toBe("inside");
		expect(JSON.stringify(details)).not.toContain(outsideFile);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("1 result(s) outside the workspace root omitted"),
		});
	});

	it("returns a bounded unsupported result when the server does not implement the method", async () => {
		const { cwd } = await workspace();
		const operations: LspOperations = {
			request: async () => {
				throw new Error("Request workspace/symbol failed: method not found (code -32601).");
			},
		};
		const result = await execute(cwd, operations, { operation: "workspace_symbol", query: "x" });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "workspace_symbol is not supported by the configured language server.",
		});
		expect(result.details).toMatchObject({ operation: "workspace_symbol", symbols: [], unsupported: true });
	});

	it("propagates cancellation instead of returning partial results", async () => {
		const { cwd } = await workspace();
		const operations: LspOperations = {
			request: async () => {
				throw new Error("Operation aborted");
			},
		};
		await expect(execute(cwd, operations, { operation: "workspace_symbol", query: "x" })).rejects.toThrow(
			"Operation aborted",
		);
	});

	it("propagates server errors that are not unsupported-method rejections", async () => {
		const { cwd } = await workspace();
		const operations: LspOperations = {
			request: async () => {
				throw new Error("server crashed");
			},
		};
		await expect(execute(cwd, operations, { operation: "workspace_symbol", query: "x" })).rejects.toThrow(
			"server crashed",
		);
	});

	it("caps results at the 2,000-symbol count bound with an honest truncated count", async () => {
		const { cwd, path } = await workspace();
		const symbols = Array.from({ length: 2_005 }, (_, index) => symbolInformation(`sym-${index}`, path, index));
		const result = await execute(
			cwd,
			{ request: async () => symbols },
			{ operation: "workspace_symbol", query: "x" },
		);

		const details = result.details as { symbols: unknown[]; truncated: number };
		expect(details.symbols).toHaveLength(2_000);
		expect(details.truncated).toBe(5);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("5 result(s) truncated"),
		});
	});

	it("caps the serialized details at a byte budget and counts what it dropped", async () => {
		const { cwd, path } = await workspace();
		// 200 symbols with a 400-byte name each: far over any details byte budget.
		const symbols = Array.from({ length: 200 }, (_, index) =>
			symbolInformation(`sym-${index}-${"n".repeat(400)}`, path, index),
		);
		const result = await execute(
			cwd,
			{ request: async () => symbols },
			{ operation: "workspace_symbol", query: "x" },
		);

		const details = result.details as { symbols: unknown[]; truncated: number };
		const serializedBytes = Buffer.byteLength(JSON.stringify(details.symbols), "utf-8");
		expect(serializedBytes).toBeLessThanOrEqual(256 * 1024);
		expect(details.truncated).toBe(200 - details.symbols.length);
	});

	it("authorizes the workspace root through the same path permission grammar", () => {
		const cwd = "/workspace";
		const definition = createLspToolDefinition(cwd, { operations: { request: async () => [] } });
		const call = { operation: "workspace_symbol" as const, query: "x" };

		const rule = definition.contract.permission.ruleForCall(call);
		expect(rule).toBe(".");
		expect(definition.contract.permission.matches(".", call)).toBe(true);
		expect(definition.contract.permission.defaultBehavior).toBe("allow");
	});
});
