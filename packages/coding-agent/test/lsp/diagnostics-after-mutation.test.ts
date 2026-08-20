import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "apex-code-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import type { DiagnosticsOperations } from "../../src/core/tools/diagnostics.ts";
import { createHarness, type Harness } from "../test-harness.ts";

const harnesses: Harness[] = [];

function toolResults(harness: Harness): Extract<AgentMessage, { role: "toolResult" }>[] {
	return harness.agent.state.messages.filter(
		(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
	);
}

function resultText(result: Extract<AgentMessage, { role: "toolResult" }>): string {
	return result.content
		.filter(
			(content): content is Extract<(typeof result.content)[number], { type: "text" }> => content.type === "text",
		)
		.map((content) => content.text)
		.join("\n");
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("diagnostics after file mutations", () => {
	test("edit reports post-mutation diagnostics and then reports clean after the fix", async () => {
		const diagnostics: DiagnosticsOperations = {
			afterMutation: async (absolutePath) => {
				const content = await readFile(absolutePath, "utf8");
				return content.includes("BROKEN")
					? {
							status: "ok" as const,
							serverId: "test-lsp",
							truncated: false,
							diagnostics: [
								{
									range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
									severity: 1,
									code: "TEST100",
									source: "test-lsp",
									message: "post-mutation content is broken",
								},
							],
						}
					: { status: "ok" as const, serverId: "test-lsp", truncated: false, diagnostics: [] };
			},
		};
		const harness = await createHarness({
			diagnosticsOperations: diagnostics,
			responses: [
				{
					toolCalls: [
						{ name: "edit", args: { path: "index.ts", edits: [{ oldText: "CLEAN", newText: "BROKEN" }] } },
					],
				},
				"broken edit complete",
				{
					toolCalls: [
						{ name: "edit", args: { path: "index.ts", edits: [{ oldText: "BROKEN", newText: "CLEAN" }] } },
					],
				},
				"fixed edit complete",
			],
		});
		harnesses.push(harness);
		await writeFile(join(harness.tempDir, "index.ts"), "const CLEAN = true;\n");

		await harness.session.prompt("break it");
		await harness.session.prompt("fix it");

		const results = toolResults(harness);
		expect(results).toHaveLength(2);
		expect(resultText(results[0])).toContain("post-mutation content is broken");
		expect(resultText(results[0])).toContain("TEST100");
		expect(results[0].details).toMatchObject({
			diagnostics: { status: "ok", diagnostics: [{ message: "post-mutation content is broken" }] },
		});
		expect(resultText(results[1])).toContain("Diagnostics: clean");
		expect(results[1].details).toMatchObject({ diagnostics: { status: "ok", diagnostics: [] } });
	});

	test("write renders unavailable distinctly from a clean diagnostics result", async () => {
		const harness = await createHarness({
			diagnosticsOperations: {
				afterMutation: async () => ({
					status: "unavailable",
					serverId: "test-lsp",
					unavailableKind: "timed-out",
					reason: "server did not publish before timeout",
				}),
			},
			responses: [
				{ toolCalls: [{ name: "write", args: { path: "index.ts", content: "const value = true;\n" } }] },
				"write complete",
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("write it");

		const [result] = toolResults(harness);
		const text = resultText(result);
		expect(text).toContain("Diagnostics unavailable: server did not publish before timeout");
		expect(text).not.toContain("Diagnostics: clean");
		expect(result.details).toMatchObject({
			diagnostics: { status: "unavailable", reason: "server did not publish before timeout" },
		});
	});
});
