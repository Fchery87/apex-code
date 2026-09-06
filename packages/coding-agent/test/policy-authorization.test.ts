/**
 * PS.1: configured verification and formatter commands run through the same
 * permission authority as tool calls. Before this seam existed the executor
 * spawned whatever the policy named, so a `permission: "deny"` policy and a
 * plan-mode session both still ran the command.
 *
 * Every case here asserts a side effect, not a return value: the command
 * writes a marker file, and a blocked command must leave no marker behind.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFormatterCommand } from "../src/core/formatter-lifecycle.ts";
import { authorizeConfiguredCommand, type ConfiguredCommandOperation } from "../src/core/permissions/policy-command.ts";
import type { PermissionResponder } from "../src/core/permissions/responder.ts";
import type { PermissionMode } from "../src/core/permissions/store.ts";
import type { FormatterPolicy, VerificationPolicy } from "../src/core/policy-loader.ts";
import { VerificationTracker } from "../src/core/verification-lifecycle.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let workspace: string;

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "apex-policy-authorization-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

const marker = (): string => join(workspace, "marker.txt");

function verificationPolicy(permission: "allow" | "ask" | "deny"): VerificationPolicy {
	return {
		kind: "verification",
		blocksCompletion: false,
		id: "verify",
		executable: process.execPath,
		argv: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker())}, "ran")`],
		cwd: "workspace",
		timeoutMs: 20_000,
		maxOutputBytes: 4096,
		maxOutputLines: 100,
		shell: false,
		permission,
		trustedSource: "project",
	};
}

function formatterPolicy(permission: "allow" | "ask" | "deny"): FormatterPolicy {
	return {
		kind: "formatter",
		mutatesFiles: true,
		declaredPaths: ["src/**"],
		id: "format",
		executable: process.execPath,
		argv: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker())}, "ran")`],
		cwd: "workspace",
		timeoutMs: 20_000,
		maxOutputBytes: 4096,
		maxOutputLines: 100,
		shell: false,
		permission,
		trustedSource: "project",
	};
}

function operation(overrides: Partial<ConfiguredCommandOperation> = {}): ConfiguredCommandOperation {
	return {
		policyId: "verify",
		executable: "/usr/bin/true",
		argv: [],
		cwd: workspace,
		writeScope: undefined,
		capabilities: new Set(["exec"] as const),
		permission: "allow",
		...overrides,
	};
}

const alwaysAllow: PermissionResponder = { ask: async () => ({ allow: true }) };
const alwaysDeny: PermissionResponder = { ask: async () => ({ allow: false }) };

const mode = (value: PermissionMode) => (): PermissionMode => value;

describe("authorizeConfiguredCommand", () => {
	it('blocks a permission:"deny" policy before any mode can widen it', async () => {
		const decision = await authorizeConfiguredCommand(operation({ permission: "deny" }), {
			getMode: mode("bypassPermissions"),
			responder: alwaysAllow,
		});
		expect(decision.block).toBe(true);
	});

	it('fails closed on permission:"ask" with no responder', async () => {
		const decision = await authorizeConfiguredCommand(operation({ permission: "ask" }), {
			getMode: mode("default"),
		});
		expect(decision.block).toBe(true);
	});

	it('blocks a declined permission:"ask"', async () => {
		const decision = await authorizeConfiguredCommand(operation({ permission: "ask" }), {
			getMode: mode("default"),
			responder: alwaysDeny,
		});
		expect(decision.block).toBe(true);
	});

	it("blocks an exec command in plan mode even when the policy allows it", async () => {
		const decision = await authorizeConfiguredCommand(operation({ permission: "allow" }), {
			getMode: mode("plan"),
			responder: alwaysAllow,
		});
		expect(decision.block).toBe(true);
	});

	it("blocks a formatter in plan mode through its fs.write capability", async () => {
		const decision = await authorizeConfiguredCommand(
			operation({ permission: "allow", capabilities: new Set(["exec", "fs.write"] as const) }),
			{ getMode: mode("plan"), responder: alwaysAllow },
		);
		expect(decision.block).toBe(true);
	});

	it('admits a permission:"allow" command in default mode', async () => {
		const decision = await authorizeConfiguredCommand(operation({ permission: "allow" }), {
			getMode: mode("default"),
		});
		expect(decision.block).toBe(false);
	});

	it('admits an approved permission:"ask" command', async () => {
		const decision = await authorizeConfiguredCommand(operation({ permission: "ask" }), {
			getMode: mode("default"),
			responder: alwaysAllow,
		});
		expect(decision.block).toBe(false);
	});
});

describe("VerificationTracker authorization", () => {
	it('spawns nothing for a permission:"deny" policy', async () => {
		const tracker = new VerificationTracker({
			workspaceRoot: workspace,
			authorize: async (op) => authorizeConfiguredCommand(op, { getMode: mode("default"), responder: alwaysAllow }),
		});
		tracker.configure([verificationPolicy("deny")], "explicit");

		const record = await tracker.runExplicit();

		expect(existsSync(marker())).toBe(false);
		expect(record?.outcome).not.toBe("verified");
		expect(tracker.completionStatus()).not.toBe("verified");
	});

	it('spawns nothing for permission:"ask" with no responder', async () => {
		const tracker = new VerificationTracker({
			workspaceRoot: workspace,
			authorize: async (op) => authorizeConfiguredCommand(op, { getMode: mode("default") }),
		});
		tracker.configure([verificationPolicy("ask")], "explicit");

		await tracker.runExplicit();

		expect(existsSync(marker())).toBe(false);
	});

	it("still runs an authorized policy", async () => {
		const tracker = new VerificationTracker({
			workspaceRoot: workspace,
			authorize: async (op) => authorizeConfiguredCommand(op, { getMode: mode("default") }),
		});
		tracker.configure([verificationPolicy("allow")], "explicit");

		const record = await tracker.runExplicit();

		expect(existsSync(marker())).toBe(true);
		expect(record?.outcome).toBe("verified");
	});
});

describe("runFormatterCommand authorization", () => {
	it('spawns nothing for a permission:"deny" formatter', async () => {
		const outcome = await runFormatterCommand(formatterPolicy("deny"), {
			workspaceRoot: workspace,
			authorize: async (op) => authorizeConfiguredCommand(op, { getMode: mode("default"), responder: alwaysAllow }),
		});

		expect(existsSync(marker())).toBe(false);
		expect(outcome.status).toBe("refused");
	});

	it("spawns nothing for a formatter blocked by plan mode", async () => {
		const outcome = await runFormatterCommand(formatterPolicy("allow"), {
			workspaceRoot: workspace,
			authorize: async (op) => authorizeConfiguredCommand(op, { getMode: mode("plan"), responder: alwaysAllow }),
		});

		expect(existsSync(marker())).toBe(false);
		expect(outcome.status).toBe("refused");
	});

	it("still runs an authorized formatter", async () => {
		writeFileSync(join(workspace, "seed.txt"), "seed");
		const outcome = await runFormatterCommand(formatterPolicy("allow"), {
			workspaceRoot: workspace,
			authorize: async (op) => authorizeConfiguredCommand(op, { getMode: mode("default") }),
		});

		expect(existsSync(marker())).toBe(true);
		expect(outcome.status).toBe("passed");
	});
});

/**
 * The seam above is only worth its tests if the real session uses it. These
 * drive `AgentSession` through its public verification and formatter entry
 * points with a permission gate installed, and assert the side effect: the
 * command's marker file never appears.
 */
describe("AgentSession authorizes configured commands", () => {
	const inertStore = () => ({
		snapshot: async () => ({ rules: [], modesBySource: new Map<never, never>(), errors: [] as [] }),
		apply: async () => {},
	});

	async function sessionWith(
		policies: Record<string, unknown>,
		permissionMode: PermissionMode,
	): Promise<{ harness: Harness; sessionMarker: string }> {
		const harness = await createHarness({
			settings: { policies: { schemaVersion: 1, ...policies } } as never,
			permissionGate: {
				store: inertStore() as never,
				getMode: () => permissionMode,
				responder: alwaysAllow,
			},
		});
		return { harness, sessionMarker: join(harness.tempDir, "marker.txt") };
	}

	it('runs no verification command for a permission:"deny" policy', async () => {
		const { harness, sessionMarker } = await sessionWith(
			{
				verification: [
					{
						id: "verify",
						executable: process.execPath,
						argv: ["-e", 'require("node:fs").writeFileSync("marker.txt", "ran")'],
						permission: "deny",
					},
				],
			},
			"default",
		);

		const status = await harness.session.requestVerification();

		expect(existsSync(sessionMarker)).toBe(false);
		expect(status).not.toBe("verified");
	});

	it("runs no formatter command in plan mode", async () => {
		const { harness, sessionMarker } = await sessionWith(
			{
				formatter: [
					{
						id: "format",
						executable: process.execPath,
						argv: ["-e", 'require("node:fs").writeFileSync("marker.txt", "ran")'],
						declaredPaths: ["src/**"],
						permission: "allow",
					},
				],
			},
			"plan",
		);

		const outcome = await harness.session.runConfiguredFormatter();

		expect(existsSync(sessionMarker)).toBe(false);
		expect(outcome?.status).toBe("refused");
	});

	it("still runs an authorized formatter through the session", async () => {
		const { harness, sessionMarker } = await sessionWith(
			{
				formatter: [
					{
						id: "format",
						executable: process.execPath,
						argv: ["-e", 'require("node:fs").writeFileSync("marker.txt", "ran")'],
						declaredPaths: ["marker.txt"],
						permission: "allow",
					},
				],
			},
			"default",
		);

		const outcome = await harness.session.runConfiguredFormatter();

		expect(existsSync(sessionMarker)).toBe(true);
		expect(outcome?.status).toBe("passed");
	});
});
