import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createMcpToolDefinition } from "../src/core/mcp/mcp-tool.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpServerManager } from "../src/core/mcp/server-manager.ts";
import type { McpServerConfig } from "../src/core/mcp/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { UNCLASSIFIED } from "../src/core/tools/contract.ts";

// H4 public-session coverage. MCP uses the local connector seam, not a wire transport.
const originalCwd = process.cwd();
let scratch: string | undefined;
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
let manager: McpServerManager | undefined;

afterEach(async () => {
	try {
		await runtime?.dispose();
		await manager?.closeAll();
	} finally {
		runtime = undefined;
		manager = undefined;
		process.chdir(originalCwd);
		if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		scratch = undefined;
	}
});

function workspace(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-verification-adapters-"));
	scratch = cwd;
	process.chdir(cwd);
	execFileSync("git", ["init", "-b", "main", cwd]);
	execFileSync("git", ["config", "user.email", "adapters@example.com"]);
	execFileSync("git", ["config", "user.name", "verification-adapters"]);
	writeFileSync("tracked.txt", "seed\n");
	execFileSync("git", ["add", "tracked.txt"]);
	execFileSync("git", ["commit", "-m", "initial"]);
	writeFileSync(
		"settings.json",
		JSON.stringify({
			policies: {
				schemaVersion: 1,
				verification: [
					{
						id: "passing-check",
						executable: process.execPath,
						argv: ["-e", "process.exit(0)"],
					},
				],
			},
		}),
	);
	return cwd;
}

async function verifiedSession(
	cwd: string,
	extensions: ExtensionFactory[] = [],
	customTools: ReturnType<typeof createMcpToolDefinition>[] = [],
) {
	const settingsManager = SettingsManager.create(cwd, cwd, { projectTrusted: true });
	runtime = await createAgentSessionRuntime(
		async ({ sessionManager }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: cwd,
				settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: extensions,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					tools: customTools.length ? customTools.map((tool) => tool.name) : undefined,
					customTools: customTools.map(
						({ renderCall: _renderCall, renderResult: _renderResult, ...tool }) => tool,
					),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir: cwd, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")) },
	);
	const session = runtime.session;
	await session.bindExtensions({});
	// As in agent-session-verification.test.ts, only provider streaming/auth is stubbed.
	(session as unknown as { _modelRuntime: { hasConfiguredAuth: () => boolean } })._modelRuntime.hasConfiguredAuth =
		() => true;
	expect(await session.requestVerification()).toBe("verified");
	expect(session.verificationStatus()).toBe("verified");
	return session;
}

async function toolTurn(
	session: AgentSession,
	name: string,
	args: { tool?: string; args?: { value: string } },
): Promise<string[]> {
	session.setActiveToolsByName([name]);
	expect(session.getActiveToolNames()).toContain(name);
	const statuses: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_end") {
			expect(event.toolName).toBe(name);
			expect(event.isError).toBe(false);
			statuses.push(session.verificationStatus());
		}
	});
	let calls = 0;
	session.agent.streamFunction = () => {
		const stream = createAssistantMessageEventStream();
		const invoke = calls++ === 0;
		queueMicrotask(() =>
			stream.push({
				type: "done",
				reason: invoke ? "toolUse" : "stop",
				message: {
					...fauxAssistantMessage("Done."),
					api: session.model!.api,
					provider: session.model!.provider,
					model: session.model!.id,
					content: invoke
						? [{ type: "toolCall", id: "adapter-call", name, arguments: args }]
						: [{ type: "text", text: "Done." }],
					stopReason: invoke ? "toolUse" : "stop",
				},
			}),
		);
		return stream;
	};
	try {
		await session.prompt("Run the adapter tool.");
	} finally {
		unsubscribe();
	}
	return statuses;
}

describe("verification through loaded extension and MCP adapters (H4)", () => {
	it.each([true, false])("loaded registerTool extension: mutating=%s", async (mutating) => {
		const cwd = workspace();
		let executed = 0;
		let loaded = 0;
		const name = mutating ? "extension_update" : "extension_read";
		const extension: ExtensionFactory = (api) => {
			loaded++;
			api.registerTool({
				...{ contract: { ...UNCLASSIFIED, capabilities: new Set(mutating ? ["fs.write"] : ["fs.read"]) } },
				name,
				label: name,
				description: "Exercise an actual loaded extension tool",
				parameters: Type.Object({}),
				async execute() {
					executed++;
					if (mutating) writeFileSync(join(cwd, "tracked.txt"), "extension mutation\n");
					return {
						content: [{ type: "text", text: readFileSync(join(cwd, "tracked.txt"), "utf8") }],
						details: {},
					};
				},
			});
		};
		const session = await verifiedSession(cwd, [extension]);
		expect(loaded).toBe(1);
		expect(await toolTurn(session, name, {})).toEqual([mutating ? "unavailable" : "verified"]);
		expect(executed).toBe(1);
		expect(readFileSync("tracked.txt", "utf8")).toBe(mutating ? "extension mutation\n" : "seed\n");
		// A subsequent automatic verification is allowed to restore the pass.
		expect(session.verificationStatus()).toBe("verified");
	});

	it.each([true, false])("real MCP proxy and manager with local connector: mutating=%s", async (mutating) => {
		const cwd = workspace();
		const server: McpServerConfig = {
			name: "workspace",
			transport: { kind: "stdio", command: "local-connector-only", args: [], env: {}, cwd },
			capabilities: new Set(mutating ? ["fs.write"] : ["fs.read"]),
			lifecycle: "lazy",
			idleTimeoutMinutes: 10,
		};
		const servers = new Map([[server.name, server]]);
		const calls: Array<{ name: string; args: unknown }> = [];
		let listed = 0;
		let closed = 0;
		manager = new McpServerManager({
			servers,
			connector: async (config) => {
				expect(config).toBe(server);
				return {
					async listTools() {
						listed++;
						return [
							{
								server: "workspace",
								name: "update",
								description: "Local workspace fixture",
								inputSchema: {
									type: "object",
									properties: { value: { type: "string" } },
									required: ["value"],
									additionalProperties: false,
								},
							},
						];
					},
					async callTool(name, args) {
						calls.push({ name, args });
						if (mutating) writeFileSync(join(cwd, "tracked.txt"), "mcp mutation\n");
						return { content: [{ type: "text", text: readFileSync(join(cwd, "tracked.txt"), "utf8") }] };
					},
					async close() {
						closed++;
					},
				};
			},
		});
		const cache = new McpMetadataCache(join(cwd, ".git", "mcp-metadata.json"));
		const definition = createMcpToolDefinition({ servers, cache, manager });
		const session = await verifiedSession(cwd, [], [definition]);
		expect(await toolTurn(session, "mcp", { tool: "workspace:update", args: { value: "requested" } })).toEqual([
			mutating ? "unavailable" : "verified",
		]);
		expect(calls).toEqual([{ name: "update", args: { value: "requested" } }]);
		expect(listed).toBe(1);
		expect(cache.all()[0]?.inputSchema).toMatchObject({ required: ["value"] });
		expect(readFileSync("tracked.txt", "utf8")).toBe(mutating ? "mcp mutation\n" : "seed\n");
		await manager.closeAll();
		expect(closed).toBe(1);
		expect(session.verificationStatus()).toBe("verified");
	});
});
