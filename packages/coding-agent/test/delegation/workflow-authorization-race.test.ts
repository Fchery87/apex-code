import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { workflowDefinitionDigest } from "../../src/core/delegation/workflow-definition.ts";
import { resolveWorkflowDefinition } from "../../src/core/delegation/workflow-files.ts";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import { createWorkflowToolDefinition } from "../../src/core/tools/workflow.ts";

const cwd = process.cwd();
let root: string | undefined;
afterEach(() => {
	process.chdir(cwd);
	if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	root = undefined;
});

describe("workflow approval execution identity", () => {
	it.each(["definition", "session", "trust", "during-approval"])(
		"refuses a changed %s after permission approval and before dispatch",
		async (change) => {
			root = mkdtempSync(join(tmpdir(), "apex-workflow-identity-"));
			process.chdir(root);
			const file = join(root, ".apex-code", "workflows", "audit.json");
			mkdirSync(join(root, ".apex-code", "workflows"), { recursive: true });
			const save = (prompt: string) =>
				writeFileSync(
					file,
					JSON.stringify({
						name: "audit",
						description: "probe",
						definition: {
							version: 1,
							steps: [{ id: "one", prompt }],
							output: { from: "one" },
						},
					}),
				);
			save("approved");
			let sessionId = "session-a";
			let trusted = true;
			const buildChildSession = vi.fn(async () => {
				throw new Error("dispatch reached");
			});
			const runtime: DelegationRuntimeOptions = {
				resolveAgent: () => ({ name: "explore", description: "read", tools: ["read"], systemPrompt: "read" }),
				getParentCapabilities: () => new Set(["delegate", "fs.read"]),
				getToolCapabilities: () => new Set(["fs.read"]),
				getDelegationDepth: () => 0,
				maxDelegationDepth: 2,
				buildChildSession,
				workflowAuthorization: {
					resolveSaved: (name) => ({
						digest: workflowDefinitionDigest(resolveWorkflowDefinition(process.cwd(), name).definition),
					}),
					sessionId: () => sessionId,
					trustContext: () => process.cwd(),
					projectTrusted: () => trusted,
				},
			};
			const tool = createWorkflowToolDefinition(runtime);
			const params = { kind: "saved" as const, name: "audit" };
			const approval = evaluateToolCall("workflow", params, {
				getContract: () => tool.contract,
				getMode: () => "default",
				store: { snapshot: async () => ({ rules: [], errors: [] }), apply: vi.fn() } as never,
				responder: {
					ask: async () => {
						if (change === "during-approval") save("changed while approving");
						return { allow: true };
					},
				},
			});
			if (change === "during-approval") {
				await expect(approval).rejects.toThrow(/identity changed during approval/i);
				expect(buildChildSession).not.toHaveBeenCalled();
				return;
			}
			expect(await approval).toEqual({ block: false });
			if (change === "definition") save("unapproved replacement");
			if (change === "session") sessionId = "session-b";
			if (change === "trust") trusted = false;
			await expect(
				tool.execute("approved-call", params, undefined, undefined, { cwd: root } as never),
			).rejects.toThrow(/approval|changed|identity|trusted/i);
			expect(buildChildSession).not.toHaveBeenCalled();
			runtime.childRunRegistry?.dispose();
		},
	);
});
