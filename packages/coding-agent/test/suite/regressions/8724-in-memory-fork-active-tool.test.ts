import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../../../src/core/agent-session-runtime.ts";
import { LspDiagnostics } from "../../../src/core/lsp/diagnostics.ts";
import { LspPool } from "../../../src/core/lsp/pool.ts";
import { LspStatusStore } from "../../../src/core/lsp/status.ts";
import { createHarness } from "../harness.ts";

describe("regression #8724: in-memory fork during an active tool turn", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("does not append the aborted turn to the replacement session", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Wait until aborted",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise<AgentToolResult<unknown>>((resolve) => {
					markToolStarted();
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						{ once: true },
					);
				}),
		};
		const harness = await createHarness({ tools: [blockingTool] });
		const lspPool = new LspPool({ workspace: harness.tempDir, servers: [], platform: process.platform });
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			lspPool,
			lspDiagnostics: new LspDiagnostics(lspPool),
			lspConfigured: false,
			lspStatus: new LspStatusStore(),
			diagnostics: [],
			close: async () => {},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: [],
		});
		const runtime = new AgentSessionRuntime(harness.session, services, createRuntime);
		cleanups.push(async () => {
			if (runtime.session !== harness.session) {
				await runtime.dispose();
			}
			harness.cleanup();
		});

		harness.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused after abort"),
		]);
		await runtime.session.prompt("first prompt");
		const firstUserEntryId = runtime.session.getUserMessagesForForking()[0]?.entryId;
		expect(firstUserEntryId).toBeDefined();

		const outgoingPrompt = runtime.session.prompt("start blocking tool");
		await toolStarted;
		const forkResult = await runtime.fork(firstUserEntryId!);
		await outgoingPrompt;
		await runtime.session.bindExtensions({});

		expect(forkResult).toEqual({ cancelled: false, selectedText: "first prompt" });
		expect(runtime.session.messages).toEqual([]);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);

		let capturedRoles: string[] = [];
		harness.setResponses([
			(context) => {
				capturedRoles = context.messages.map((message) => message.role);
				return fauxAssistantMessage("next response");
			},
		]);
		await runtime.session.prompt("next prompt");

		expect(capturedRoles).toEqual(["user"]);
	});
});
