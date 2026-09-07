import { describe, expect, it, vi } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import { createInteractiveResponder } from "../../src/core/permissions/responder.ts";
import type { PermissionRule } from "../../src/core/permissions/rules.ts";
import type { ToolContract } from "../../src/core/tools/contract.ts";

function uiWithSelectReturning(value: string | undefined) {
	return { select: vi.fn().mockResolvedValue(value) };
}

const ALLOW_SESSION = "Allow for this session";

describe("createInteractiveResponder", () => {
	it("renders the tool's describe() output (passed in as `description`) in the prompt", async () => {
		const ui = uiWithSelectReturning("Deny");
		const responder = createInteractiveResponder(ui);

		await responder.ask({ toolName: "bash", description: 'Run bash commands matching "git commit:*"' });

		expect(ui.select).toHaveBeenCalledTimes(1);
		const [title] = ui.select.mock.calls[0];
		expect(title).toContain("bash");
		expect(title).toContain('Run bash commands matching "git commit:*"');
	});

	it("maps 'Allow once' to a one-time allow, not persisted", async () => {
		const ui = uiWithSelectReturning("Allow once");
		const responder = createInteractiveResponder(ui);
		const answer = await responder.ask({ toolName: "write", description: "Write file.txt" });
		expect(answer).toEqual({ allow: true });
	});

	it("maps the session-scoped choice to an allow with persist — and invents no rule content itself", async () => {
		const ui = uiWithSelectReturning(ALLOW_SESSION);
		const responder = createInteractiveResponder(ui);
		const answer = await responder.ask({ toolName: "write", description: "Write file.txt" });
		expect(answer).toEqual({ allow: true, persist: true });
		// The responder's answer carries only allow/persist — generating the actual
		// rule string is the gate's job (via the tool's own ruleForCall()), never
		// the responder's. There is no field here for it to invent one into.
		expect(Object.keys(answer)).toEqual(expect.arrayContaining(["allow"]));
		expect("ruleContent" in answer).toBe(false);
	});

	it("maps 'Deny' to a denial", async () => {
		const ui = uiWithSelectReturning("Deny");
		const responder = createInteractiveResponder(ui);
		const answer = await responder.ask({ toolName: "bash", description: "Run echo hi" });
		expect(answer).toEqual({ allow: false });
	});

	it("treats a cancelled/dismissed prompt (no selection) as a denial", async () => {
		const ui = uiWithSelectReturning(undefined);
		const responder = createInteractiveResponder(ui);
		const answer = await responder.ask({ toolName: "bash", description: "Run echo hi" });
		expect(answer).toEqual({ allow: false });
	});

	it("presents exactly the three expected options, in a stable order", async () => {
		const ui = uiWithSelectReturning("Deny");
		const responder = createInteractiveResponder(ui);
		await responder.ask({ toolName: "read", description: "Read a.txt" });
		const [, options] = ui.select.mock.calls[0];
		expect(options).toEqual(["Allow once", ALLOW_SESSION, "Deny"]);
	});

	it("offers no choice that claims a grant outliving the session", async () => {
		const ui = uiWithSelectReturning("Deny");
		const responder = createInteractiveResponder(ui);
		await responder.ask({ toolName: "read", description: "Read a.txt" });
		const [, options] = ui.select.mock.calls[0] as [string, string[]];
		for (const option of options) {
			expect(option).not.toMatch(/always|permanent|forever/i);
		}
	});
});

const exactSpec = {
	defaultBehavior: "ask" as const,
	matches: (ruleContent: string, params: { path: string }) => ruleContent === params.path,
	describe: (ruleContent: string) => `exact:${ruleContent}`,
	ruleForCall: (params: { path: string }) => params.path,
};

const contract = {
	capabilities: new Set(),
	permission: exactSpec,
	context: {},
	evidence: {},
} as unknown as ToolContract;

function recordingStore() {
	const applied: Array<{ type: string; destination?: string; rules?: readonly PermissionRule[] }> = [];
	return {
		applied,
		snapshot: async () => ({ rules: [] as PermissionRule[], modesBySource: new Map<never, never>(), errors: [] }),
		apply: async (update: { type: string; destination?: string; rules?: readonly PermissionRule[] }) => {
			applied.push(update);
		},
	};
}

describe("the session choice and the rule the gate writes", () => {
	it("writes a session-destination rule whose content is exactly ruleForCall()", async () => {
		const store = recordingStore();
		const ui = uiWithSelectReturning(ALLOW_SESSION);
		const decision = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{
				getContract: () => contract,
				store: store as never,
				getMode: () => "default" as const,
				responder: createInteractiveResponder(ui),
			},
		);

		expect(decision.block).toBe(false);
		expect(store.applied).toHaveLength(1);
		expect(store.applied[0]).toEqual({
			type: "addRules",
			destination: "session",
			rules: [{ toolName: "read", behavior: "allow", ruleContent: "a.txt" }],
		});
	});

	it("writes nothing when the choice is allow once", async () => {
		const store = recordingStore();
		const ui = uiWithSelectReturning("Allow once");
		const decision = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{
				getContract: () => contract,
				store: store as never,
				getMode: () => "default" as const,
				responder: createInteractiveResponder(ui),
			},
		);

		expect(decision.block).toBe(false);
		expect(store.applied).toHaveLength(0);
	});
});
