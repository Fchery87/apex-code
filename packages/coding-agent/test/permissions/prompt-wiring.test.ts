import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import { createInteractiveResponder } from "../../src/core/permissions/responder.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "apex-wiring-"));
	dirs.push(dir);
	return dir;
}

function fakeUi(choice: string, typed?: string) {
	return {
		select: vi.fn().mockResolvedValue(choice),
		input: vi.fn().mockResolvedValue(typed),
	};
}

/**
 * One pass down the whole chain, with nothing stubbed between the tool contract
 * and the prompt. A seam can be defined, tested in isolation, and still never
 * reached in the product; this is the test that would notice.
 */
describe("the permission prompt, end to end", () => {
	it("carries a real diff from the tool contract to the prompt's options", async () => {
		const cwd = await scratchDir();
		await writeFile(join(cwd, "auth.ts"), "const a = 1;\nconst b = 2;\n");
		const definition = createEditToolDefinition(cwd);
		const ui = fakeUi("Deny");

		const decision = await evaluateToolCall(
			"edit",
			{ path: "auth.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }] },
			{
				getContract: () => definition.contract,
				store: new FilePermissionRuleStore({
					cwd,
					agentDir: join(cwd, "agent"),
					policyPath: join(cwd, "missing.json"),
				}),
				getMode: () => "default",
				responder: createInteractiveResponder(ui),
			},
		);

		expect(decision.block).toBe(true);
		const [title, options, opts] = ui.select.mock.calls[0] as [
			string,
			string[],
			{ preview?: { kind: string; lines: readonly string[] } } | undefined,
		];

		expect(title).toContain("edit");
		expect(options).toContain("Allow for this session");
		expect(options).toContain("Reject and say what to do instead");
		expect(opts?.preview?.kind).toBe("diff");
		expect(opts?.preview?.lines.join("\n")).toContain("const b = 3;");
	});

	it("carries typed guidance back into the blocked reason", async () => {
		const cwd = await scratchDir();
		await writeFile(join(cwd, "auth.ts"), "const a = 1;\n");
		const definition = createEditToolDefinition(cwd);
		const ui = fakeUi("Reject and say what to do instead", "edit the config instead");

		const decision = await evaluateToolCall(
			"edit",
			{ path: "auth.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
			{
				getContract: () => definition.contract,
				store: new FilePermissionRuleStore({
					cwd,
					agentDir: join(cwd, "agent"),
					policyPath: join(cwd, "missing.json"),
				}),
				getMode: () => "default",
				responder: createInteractiveResponder(ui),
			},
		);

		expect(ui.input).toHaveBeenCalledTimes(1);
		expect(decision.reason).toContain("edit the config instead");
	});

	it("writes a refusal to the real store and honours it on the next call", async () => {
		const cwd = await scratchDir();
		await writeFile(join(cwd, "auth.ts"), "const a = 1;\n");
		const definition = createEditToolDefinition(cwd);
		const store = new FilePermissionRuleStore({
			cwd,
			agentDir: join(cwd, "agent"),
			policyPath: join(cwd, "missing.json"),
		});
		const responder = { ask: vi.fn().mockResolvedValue({ allow: false, persist: true }) };
		const input = { path: "auth.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] };
		const options = { getContract: () => definition.contract, store, getMode: () => "default" as const, responder };

		await evaluateToolCall("edit", input, options);
		const second = await evaluateToolCall("edit", input, options);

		expect(second.block).toBe(true);
		expect(responder.ask).toHaveBeenCalledTimes(1);
	});
});
