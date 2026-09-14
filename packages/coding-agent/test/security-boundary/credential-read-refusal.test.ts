import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionMode } from "../../src/core/permissions/store.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createFindToolDefinition } from "../../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../../src/core/tools/ls.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

/**
 * The agent directory's `auth.json` is the one file a session can read that the harness
 * itself wrote, and it holds the provider key in cleartext. `read`, `grep`, `ls`, and
 * `find` default to allow and `path-permission.ts` has no containment check, so reading it
 * was an ordinary tool call that raised no decision. Under the process boundary the home
 * directory was hidden and that file was deliberately mounted; ADR 0032 removed the
 * boundary and left the default.
 *
 * `auth.json` is redirected to scratch through `APEX_CODE_AUTH_PATH` so no case can touch
 * a real credential file.
 */
const SECRET = "sk-ant-CREDENTIAL-REFUSAL-PROBE";
const harnesses: Harness[] = [];
let scratch: string;
let authPath: string;
let originalAuthPath: string | undefined;

beforeEach(() => {
	scratch = join(process.cwd(), "..", `cred-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(scratch, "agent"), { recursive: true });
	authPath = join(scratch, "agent", "auth.json");
	writeFileSync(authPath, JSON.stringify({ anthropic: { apiKey: SECRET } }));
	originalAuthPath = process.env.APEX_CODE_AUTH_PATH;
	process.env.APEX_CODE_AUTH_PATH = authPath;
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	if (originalAuthPath === undefined) delete process.env.APEX_CODE_AUTH_PATH;
	else process.env.APEX_CODE_AUTH_PATH = originalAuthPath;
	rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function session(mode: PermissionMode = "default", seedProjectAllowAll = false) {
	const harness = await createHarness({
		permissionGate: {
			store: new FilePermissionRuleStore({
				cwd: process.cwd(),
				projectTrusted: true,
				initialRules: seedProjectAllowAll
					? [
							{ source: "project", behavior: "allow", toolName: "read", ruleContent: "**" },
							{ source: "project", behavior: "allow", toolName: "grep", ruleContent: "**" },
						]
					: [],
			}),
			getMode: () => mode,
		},
	});
	harnesses.push(harness);
	return harness;
}

async function leaks(harness: Harness, tool: string, params: Record<string, unknown>): Promise<boolean> {
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(tool, params)], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("go");
	return JSON.stringify(harness.session.messages).includes(SECRET);
}

describe("the read-shaped tools refuse the agent directory's credential file", () => {
	it("CONTROL still reads an ordinary workspace file with no decision", async () => {
		const harness = await session();
		writeFileSync(join(harness.tempDir, "ordinary.txt"), "ORDINARY-CONTENT");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: join(harness.tempDir, "ordinary.txt") })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(JSON.stringify(harness.session.messages)).toContain("ORDINARY-CONTENT");
	});

	it("refuses read by absolute path", async () => {
		expect(await leaks(await session(), "read", { path: authPath })).toBe(false);
	});

	it("refuses read through a symlink", async () => {
		const harness = await session();
		const link = join(harness.tempDir, "link.json");
		symlinkSync(authPath, link);
		expect(await leaks(harness, "read", { path: link })).toBe(false);
	});

	/**
	 * `grep`, `ls`, and `find` are not in the suite harness's base tool set, so a session
	 * call for them returns "Tool grep not found" and would pass this file for the wrong
	 * reason. They are decided at the gate instead, which is the same shared
	 * `createPathPermissionSpec` the session path resolves through. Each has a control on
	 * an ordinary path, so a refusal is distinguishable from a tool that refuses everything.
	 */
	describe("the other three read-shaped tools, decided at the gate", () => {
		const agentDir = () => join(scratch, "agent");
		// A sibling of the agent directory, not `scratch` itself. `scratch` is a true
		// ancestor of the credential file and is therefore protected on purpose, which is
		// what the first draft of these controls got wrong.
		const ordinaryDir = () => {
			const dir = join(scratch, "ordinary");
			mkdirSync(dir, { recursive: true });
			return dir;
		};

		async function behaviorFor(
			definition: { contract: { permission: unknown } },
			toolName: string,
			params: Record<string, unknown>,
		): Promise<boolean> {
			const decision = await evaluateToolCall(toolName, params, {
				getContract: () => definition.contract as never,
				store: new FilePermissionRuleStore({ cwd: process.cwd(), projectTrusted: true }),
				getMode: () => "default",
			});
			return decision.block;
		}

		it("grep is allowed on an ordinary path and refused on the credential directory", async () => {
			const definition = createGrepToolDefinition(scratch);
			expect(await behaviorFor(definition, "grep", { pattern: "x", path: ordinaryDir() })).toBe(false);
			expect(await behaviorFor(definition, "grep", { pattern: "x", path: agentDir() })).toBe(true);
			expect(await behaviorFor(definition, "grep", { pattern: "x", path: authPath })).toBe(true);
		});

		it("ls is allowed on an ordinary path and refused on the credential directory", async () => {
			const definition = createLsToolDefinition(scratch);
			expect(await behaviorFor(definition, "ls", { path: ordinaryDir() })).toBe(false);
			expect(await behaviorFor(definition, "ls", { path: agentDir() })).toBe(true);
		});

		it("find is allowed on an ordinary path and refused on the credential directory", async () => {
			const definition = createFindToolDefinition(scratch);
			expect(await behaviorFor(definition, "find", { pattern: "*", path: ordinaryDir() })).toBe(false);
			expect(await behaviorFor(definition, "find", { pattern: "*", path: agentDir() })).toBe(true);
		});
	});

	it("a project rule granting every path does not unlock it", async () => {
		expect(await leaks(await session("default", true), "read", { path: authPath })).toBe(false);
	});

	it("bypassPermissions does not unlock it", async () => {
		expect(await leaks(await session("bypassPermissions"), "read", { path: authPath })).toBe(false);
	});
});
