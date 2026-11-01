import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { rmScratchResilient, scratchDir } from "../suite/scratch.ts";
import { createHarness } from "../test-harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

/**
 * /<name> loads a saved workflow and the tool runs it. The parent prompt is the
 * script's return value, not the script and not a child's transcript.
 */

const cleanups: Array<() => void> = [];
const sessions: AgentSession[] = [];
const scratches: string[] = [];

afterEach(async () => {
	while (cleanups.length > 0) cleanups.pop()?.();
	for (const session of sessions.splice(0)) session.dispose();
	for (const dir of scratches.splice(0)) await rmScratchResilient(dir);
});

function saveScript(dir: string, name: string, body: string): void {
	const workflows = join(dir, ".apex-code", "workflows");
	mkdirSync(workflows, { recursive: true });
	writeFileSync(join(workflows, `${name}.js`), `---\nname: ${name}\ndescription: saved\n---\n${body}\n`);
}

describe("workflow slash command", () => {
	it("rejects a saved JavaScript workflow with migration guidance before dispatch", async () => {
		const harness = await createHarness({ responses: ["done"] });
		cleanups.push(harness.cleanup);
		saveScript(harness.tempDir, "audit", 'return ["one", "two"];');

		await expect(harness.session.prompt("/audit")).rejects.toThrow(/JavaScript|JSON|migration/i);
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(0);
	});

	it("rejects a saved JavaScript workflow after the permission gate allows its name", async () => {
		const cwd = await scratchDir("apex-workflow-untrusted-");
		scratches.push(cwd);
		saveScript(cwd, "audit", "return 1;");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const store = new FilePermissionRuleStore({
			cwd,
			agentDir,
			projectTrusted: false,
			policyPath: join(cwd, "absent-policy.json"),
		});
		await store.apply({
			type: "addRules",
			destination: "user",
			rules: [{ toolName: "workflow", behavior: "allow", ruleContent: "audit" }],
		});
		const faux = fauxProvider({ provider: `workflow-command-${Math.random().toString(36).slice(2)}` });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [faux.getModel().provider] });
		const asked: string[] = [];
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRuntime: runtime,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
			resourceLoader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([], cwd) }),
			permissionGate: {
				store,
				getMode: () => "default",
				responder: {
					ask: async (request) => {
						asked.push(request.toolName);
						return { allow: false };
					},
				},
			},
		});
		sessions.push(session);

		await session.prompt("/audit");

		expect(asked).toEqual(["workflow"]);
		expect(session.messages.filter((message) => message.role === "user")).toHaveLength(0);
	});

	it("keeps an unknown slash command as the prompt and rejects saved JavaScript", async () => {
		const harness = await createHarness({ responses: ["done"] });
		cleanups.push(harness.cleanup);
		saveScript(harness.tempDir, "audit", "return args;");

		await expect(harness.session.prompt('/audit {"paths":2}')).rejects.toThrow(/JavaScript|JSON|migration/i);
		await harness.session.prompt("/missing");

		const texts = harness.session.messages
			.filter((message) => message.role === "user")
			.map((message) => (message.role === "user" && typeof message.content !== "string" ? message.content : []))
			.map((content) => content.find((part) => part.type === "text"))
			.map((part) => (part && "text" in part ? part.text : ""));
		expect(texts).toEqual(["/missing"]);
	});
});
