import { describe, expect, it, vi } from "vitest";
import { createInteractiveResponder } from "../../src/core/permissions/responder.ts";

function uiWithSelectReturning(value: string | undefined) {
	return { select: vi.fn().mockResolvedValue(value) };
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

	it("maps 'Always allow' to an allow with persist — and invents no rule content itself", async () => {
		const ui = uiWithSelectReturning("Always allow");
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
		expect(options).toEqual(["Allow once", "Always allow", "Deny"]);
	});
});
