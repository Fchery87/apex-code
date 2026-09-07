import { describe, expect, it, vi } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import { createInteractiveResponder } from "../../src/core/permissions/responder.ts";
import type { PermissionRule } from "../../src/core/permissions/rules.ts";
import type { ToolContract } from "../../src/core/tools/contract.ts";

function uiWithSelectReturning(value: string | undefined) {
	return { select: vi.fn().mockResolvedValue(value) };
}

const ALLOW_SESSION = "Allow for this session";
const REJECT_WITH_GUIDANCE = "Reject and say what to do instead";

function uiWith(select: string | undefined, input?: string | undefined) {
	return {
		select: vi.fn().mockResolvedValue(select),
		input: vi.fn().mockResolvedValue(input),
	};
}

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

	it("presents every offerable option in a stable order", async () => {
		const ui = uiWith("Deny");
		const responder = createInteractiveResponder(ui);
		await responder.ask({
			toolName: "read",
			description: "Read a.txt",
			sessionScope: { description: "Read a.txt" },
		});
		const [, options] = ui.select.mock.calls[0] as [string, string[]];
		expect(options).toEqual(["Allow once", ALLOW_SESSION, REJECT_WITH_GUIDANCE, "Deny"]);
	});

	it("falls back to allow-once and deny when the call offers neither scope nor text entry", async () => {
		const ui = uiWithSelectReturning("Deny");
		const responder = createInteractiveResponder(ui);
		await responder.ask({ toolName: "read", description: "Read a.txt" });
		const [, options] = ui.select.mock.calls[0];
		expect(options).toEqual(["Allow once", "Deny"]);
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

describe("declining with guidance", () => {
	it("offers the guidance choice and carries the typed text back", async () => {
		const ui = uiWith(REJECT_WITH_GUIDANCE, "edit the config instead");
		const responder = createInteractiveResponder(ui);

		const answer = await responder.ask({
			toolName: "edit",
			description: "Edit src/auth/middleware.ts",
			sessionScope: { description: "Edit src/auth/middleware.ts" },
		});

		expect(ui.input).toHaveBeenCalledTimes(1);
		expect(answer).toEqual({ allow: false, guidance: "edit the config instead" });
	});

	it("still denies when the guidance prompt is dismissed", async () => {
		const ui = uiWith(REJECT_WITH_GUIDANCE, undefined);
		const responder = createInteractiveResponder(ui);

		const answer = await responder.ask({ toolName: "edit", description: "Edit a.ts" });

		expect(answer).toEqual({ allow: false });
	});

	it("omits the guidance choice when the host cannot collect text", async () => {
		const ui = { select: vi.fn().mockResolvedValue("Deny") };
		const responder = createInteractiveResponder(ui);

		await responder.ask({ toolName: "edit", description: "Edit a.ts" });

		const [, options] = ui.select.mock.calls[0] as [string, string[]];
		expect(options).not.toContain(REJECT_WITH_GUIDANCE);
	});
});

describe("offering a session grant only when one would be written", () => {
	it("omits the session choice when the tool yields no rule", async () => {
		const ui = uiWith("Deny");
		const responder = createInteractiveResponder(ui);

		await responder.ask({ toolName: "ask_user", description: "Run ask_user" });

		const [, options] = ui.select.mock.calls[0] as [string, string[]];
		expect(options).not.toContain(ALLOW_SESSION);
		expect(options).toContain("Allow once");
	});

	it("offers it when the tool yields a rule", async () => {
		const ui = uiWith("Deny");
		const responder = createInteractiveResponder(ui);

		await responder.ask({
			toolName: "edit",
			description: "Edit a.ts",
			sessionScope: { description: "Edit a.ts" },
		});

		const [, options] = ui.select.mock.calls[0] as [string, string[]];
		expect(options).toContain(ALLOW_SESSION);
	});
});

describe("guidance reaching the blocked tool result", () => {
	it("puts the user's instruction in the gate's reason and writes no rule", async () => {
		const store = recordingStore();
		const decision = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{
				getContract: () => contract,
				store: store as never,
				getMode: () => "default" as const,
				responder: { ask: async () => ({ allow: false, guidance: "read b.txt instead" }) },
			},
		);

		expect(decision.block).toBe(true);
		expect(decision.reason).toContain("read b.txt instead");
		expect(store.applied).toHaveLength(0);
	});

	it("keeps the plain decline when no guidance is given", async () => {
		const store = recordingStore();
		const decision = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{
				getContract: () => contract,
				store: store as never,
				getMode: () => "default" as const,
				responder: { ask: async () => ({ allow: false }) },
			},
		);

		expect(decision.block).toBe(true);
		expect(decision.reason).toContain("declined");
		expect(decision.reason).not.toContain("instead");
	});

	it("bounds runaway guidance rather than pasting it whole into the transcript", async () => {
		const decision = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{
				getContract: () => contract,
				store: recordingStore() as never,
				getMode: () => "default" as const,
				responder: { ask: async () => ({ allow: false, guidance: "x".repeat(5000) }) },
			},
		);

		expect(decision.reason?.length ?? 0).toBeLessThan(1000);
	});

	it("tells the gate what scope it can actually offer", async () => {
		const asked: unknown[] = [];
		await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{
				getContract: () => contract,
				store: recordingStore() as never,
				getMode: () => "default" as const,
				responder: {
					ask: async (request) => {
						asked.push(request);
						return { allow: false };
					},
				},
			},
		);

		expect(asked[0]).toMatchObject({ toolName: "read", sessionScope: { description: "exact:a.txt" } });
	});
});
