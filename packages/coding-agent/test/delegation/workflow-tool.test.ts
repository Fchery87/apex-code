import { describe, expect, it, vi } from "vitest";
import type { DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { parseWorkflowRequest, runWorkflow } from "../../src/core/delegation/workflow-run.ts";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createWorkflowTool, createWorkflowToolDefinition } from "../../src/core/tools/workflow.ts";

function runtime(): DelegationRuntimeOptions {
	return {
		resolveAgent: () => undefined,
		getParentCapabilities: () => new Set(["delegate"]),
		getToolCapabilities: () => undefined,
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		buildChildSession: vi.fn(async () => {
			throw new Error("must not dispatch");
		}),
	};
}

describe("workflow public refusal boundaries", () => {
	it.each(["default", "bypassPermissions", "allow-rule"] as const)(
		"denies untrusted saved and inline calls without asking in %s",
		async (mode) => {
			for (const kind of ["saved", "inline"] as const) {
				const definition = { version: 1, steps: [{ id: "one", prompt: "go" }], output: { from: "one" } };
				const options: DelegationRuntimeOptions = {
					...runtime(),
					workflowAuthorization: {
						resolveSaved: () => ({ definition, digest: "digest" }),
						sessionId: () => "session",
						trustContext: () => "project",
						projectTrusted: () => false,
					},
				};
				const tool = createWorkflowToolDefinition(options);
				const ask = vi.fn(async () => ({ allow: true }));
				const ruleContent = tool.contract.permission.ruleForCall(
					kind === "saved" ? { kind, name: "audit" } : { kind, definition },
				);
				const store: PermissionRuleStore = {
					snapshot: async () => ({
						rules:
							mode === "allow-rule"
								? [
										{
											source: "session",
											behavior: "allow",
											toolName: "workflow",
											ruleContent: ruleContent ?? undefined,
										},
									]
								: [],
						errors: [],
						modesBySource: new Map(),
					}),
					apply: vi.fn(),
				};
				await expect(
					evaluateToolCall("workflow", kind === "saved" ? { kind, name: "audit" } : { kind, definition }, {
						getContract: () => tool.contract,
						getMode: () => (mode === "allow-rule" ? "default" : mode),
						store,
						responder: { ask },
					}),
				).resolves.toMatchObject({ block: true });
				expect(ask).not.toHaveBeenCalled();
				expect(options.buildChildSession).not.toHaveBeenCalled();
			}
		},
	);
	it("binds saved workflow approval to the resolved digest and session context", async () => {
		let digest = "digest-a";
		let sessionId = "session-a";
		let trustContext = "project-a";
		const options = {
			...runtime(),
			workflowAuthorization: {
				resolveSaved: () => ({ definition: { version: 1 }, digest }),
				sessionId: () => sessionId,
				trustContext: () => trustContext,
				projectTrusted: () => true,
			},
		};
		const tool = createWorkflowToolDefinition(options);
		const params = { kind: "saved" as const, name: "audit" };
		const ruleContent = tool.contract.permission.ruleForCall(params);
		const gate = () =>
			evaluateToolCall("workflow", params, {
				getContract: () => tool.contract,
				getMode: () => "default" as const,
				store: {
					snapshot: async () => ({
						rules: [
							{
								source: "session",
								behavior: "allow",
								toolName: "workflow",
								ruleContent: ruleContent ?? undefined,
							},
						],
						errors: [],
					}),
					apply: vi.fn(),
				} as never,
			});
		await expect(gate()).resolves.toEqual({ block: false });
		digest = "digest-b";
		await expect(gate()).resolves.toMatchObject({ block: true });
		digest = "digest-a";
		sessionId = "session-b";
		await expect(gate()).resolves.toMatchObject({ block: true });
		sessionId = "session-a";
		trustContext = "project-b";
		await expect(gate()).resolves.toMatchObject({ block: true });
	});

	it("refuses a legacy request before permission or dispatch", () => {
		expect(() => parseWorkflowRequest({ script: "return 3", name: "audit" })).toThrow(
			/JavaScript.*disabled|migration/i,
		);
	});

	it("denies disabled legacy workflows without asking or dispatching", async () => {
		const responder = { ask: vi.fn(async () => ({ allow: true })) };
		const store = {
			snapshot: async () => ({ rules: [], modesBySource: new Map(), errors: [] }),
			apply: vi.fn(async () => undefined),
		} as unknown as PermissionRuleStore;
		const tool = createWorkflowToolDefinition(runtime());
		await expect(
			evaluateToolCall(
				"workflow",
				{ kind: "inline", definition: "return 3" },
				{
					getContract: () => tool.contract,
					store,
					getMode: () => "default",
					responder,
				},
			),
		).rejects.toThrow(/JavaScript.*disabled|migration/i);
		expect(responder.ask).not.toHaveBeenCalled();
		expect(store.apply).not.toHaveBeenCalled();
	});

	it("refuses at the wrapped public tool boundary too", async () => {
		const options = runtime();
		await expect(
			createWorkflowTool(options).execute("call", { kind: "inline", definition: "return 3" }),
		).rejects.toThrow(/JavaScript.*disabled|migration/i);
		expect(options.buildChildSession).not.toHaveBeenCalled();
	});

	it("does not let an untrusted project bypass saved workflow approval", async () => {
		const options = {
			...runtime(),
			workflowAuthorization: {
				resolveSaved: () => ({ definition: { version: 1 }, digest: "digest-a" }),
				sessionId: () => "session-a",
				trustContext: () => "project-a",
				projectTrusted: () => false,
			},
		};
		const tool = createWorkflowToolDefinition(options);
		await expect(
			evaluateToolCall(
				"workflow",
				{ kind: "saved", name: "audit" },
				{
					getContract: () => tool.contract,
					getMode: () => "bypassPermissions",
					store: { snapshot: async () => ({ rules: [], errors: [] }), apply: vi.fn() } as never,
				},
			),
		).resolves.toMatchObject({ block: true });
	});

	it.each(["return 1", 'await worker("do not start");', 'return args.constructor.constructor("return process")();'])(
		"refuses JavaScript at public runWorkflow: %s",
		async (script) => {
			const options = runtime();
			await expect(runWorkflow(options, script)).rejects.toThrow(/JavaScript.*(?:disabled|unsupported|no longer)/i);
			expect(options.buildChildSession).not.toHaveBeenCalled();
		},
	);

	it("refuses forged saved authority through the full permission gate", async () => {
		const options = runtime();
		const tool = createWorkflowToolDefinition(options);
		const ask = vi.fn(async () => ({ allow: true }));
		const params = { kind: "saved" as const, name: "audit" };
		await expect(
			evaluateToolCall("workflow", params, {
				getContract: () => tool.contract,
				getMode: () => "bypassPermissions",
				store: { snapshot: async () => ({ rules: [], errors: [] }), apply: vi.fn() } as never,
				responder: { ask },
			}),
		).resolves.toEqual({ block: false });
		expect(ask).not.toHaveBeenCalled();
		await expect(tool.execute("forged", params, undefined, undefined, { hasUI: false } as never)).rejects.toThrow(
			/not found|migration/i,
		);
		expect(options.buildChildSession).not.toHaveBeenCalled();
	});

	it("direct tool execution cannot bypass refusal with a name", async () => {
		const options = runtime();
		const tool = createWorkflowToolDefinition(options);
		await expect(
			tool.execute("forged", { kind: "saved", name: "audit" }, undefined, undefined, { hasUI: false } as never),
		).rejects.toThrow(/not found|migration/i);
		expect(options.buildChildSession).not.toHaveBeenCalled();
	});
});
