import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionRule } from "../../src/core/permissions/rules.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";

const bash = createBashToolDefinition(process.cwd());
const allowAll: PermissionRule = { source: "user", behavior: "allow", toolName: "bash" };

function store(rules: PermissionRule[] = []) {
	return { snapshot: async () => ({ rules, modesBySource: new Map(), errors: [] }), apply: async () => {} };
}

const approving = { ask: async () => ({ allow: true }) };

async function decide(
	command: string,
	options: { mode?: "default" | "bypassPermissions"; rules?: PermissionRule[]; responder?: boolean } = {},
) {
	return evaluateToolCall(
		"bash",
		{ command },
		{
			getContract: () => bash.contract,
			store: store(options.rules),
			getMode: () => options.mode ?? "default",
			...(options.responder ? { responder: approving } : {}),
		},
	);
}

const denied = [
	"rm -rf /",
	"rm -rf ~",
	"rm -rf $HOME",
	'sh -c "rm -rf /"',
	"sudo rm -rf /",
	`rm -rf ${join(homedir(), ".ssh")}`,
];

describe("bash catastrophic targets", () => {
	for (const command of denied) {
		it(`denies ${command} with no rules, an allow-all rule, and bypass`, async () => {
			for (const setup of [
				{},
				{ rules: [allowAll] },
				{ mode: "bypassPermissions" as const },
				{ mode: "bypassPermissions" as const, responder: true },
				{ rules: [allowAll], responder: true },
			]) {
				const decision = await decide(command, setup);
				expect(decision.block, JSON.stringify(setup)).toBe(true);
				expect(decision.reason).toMatch(/refus/i);
			}
		});
	}

	it("still allows a read-only git status", async () => {
		const decision = await decide("git status");
		expect(decision.block).toBe(false);
	});

	it("still asks before deleting a file in the workspace", async () => {
		const decision = await decide("rm file.txt");
		expect(decision.block).toBe(true);
		expect(decision.reason).toMatch(/approval/);
	});

	it("does not treat a quoted mention as a delete", async () => {
		const decision = await decide('echo "rm -rf /"');
		expect(decision.reason ?? "").not.toMatch(/refus/i);
	});
});
