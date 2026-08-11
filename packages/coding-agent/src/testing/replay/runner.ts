import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	InMemoryModelsStore,
	type Message,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import { Agent, type AgentTool, type AgentToolResult } from "apex-code-agent-core";
import { AuthStorage } from "../../core/auth-storage.ts";
import { estimateTokens } from "../../core/compaction/compaction.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
	type SessionMessageEntry,
} from "../../core/session-manager.ts";
import { buildSystemPrompt } from "../../core/system-prompt.ts";
import { createAllToolDefinitions } from "../../core/tools/index.ts";
import { buildReplayMetrics, type ReplayMetrics } from "./metrics.ts";
import { registerRecordedProvider } from "./recorded-provider.ts";

export interface ReplayResult {
	turns: number;
	requests: number;
	networkCalls: number;
	responses: AssistantMessage[];
	toolResults: ToolResultMessage[];
	metrics: ReplayMetrics;
}

function isVersionThreeHeader(entry: unknown): entry is SessionHeader & { version: 3 } {
	if (entry === null || typeof entry !== "object") return false;
	return Reflect.get(entry, "type") === "session" && Reflect.get(entry, "version") === 3;
}

function isSessionEntry(entry: unknown): entry is SessionEntry {
	if (entry === null || typeof entry !== "object") return false;
	const type = Reflect.get(entry, "type");
	const id = Reflect.get(entry, "id");
	const parentId = Reflect.get(entry, "parentId");
	return (
		type !== "session" &&
		typeof type === "string" &&
		typeof id === "string" &&
		(parentId === null || typeof parentId === "string")
	);
}

function validateSessionTree(entries: readonly SessionEntry[]): void {
	const ids = new Set<string>();
	const parentById = new Map<string, string | null>();
	let roots = 0;
	for (const entry of entries) {
		if (!entry || typeof entry.id !== "string" || ids.has(entry.id))
			throw new Error("Replay session contains invalid or duplicate entry ids");
		ids.add(entry.id);
		parentById.set(entry.id, entry.parentId);
		if (entry.parentId === null) roots++;
		else if (typeof entry.parentId !== "string") throw new Error("Replay session contains an invalid parentId");
	}
	if (roots !== 1) throw new Error("Replay session must contain exactly one tree root");
	for (const entry of entries) {
		if (entry.parentId !== null && !ids.has(entry.parentId))
			throw new Error(`Replay session has missing parent ${entry.parentId}`);
		const seen = new Set<string>();
		let current: string | null = entry.id;
		while (current !== null) {
			if (seen.has(current)) throw new Error("Replay session contains a parent cycle");
			seen.add(current);
			current = parentById.get(current) ?? null;
		}
	}
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function selectedResponses(entries: readonly SessionEntry[]): AssistantMessage[] {
	return entries
		.filter(isMessageEntry)
		.map((entry) => entry.message)
		.filter((message): message is AssistantMessage => message.role === "assistant");
}

function selectedToolResults(entries: readonly SessionEntry[]): ToolResultMessage[] {
	return entries
		.filter(isMessageEntry)
		.map((entry) => entry.message)
		.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function selectedUserEntries(entries: readonly SessionEntry[]): SessionMessageEntry[] {
	return entries.filter(isMessageEntry).filter((entry) => entry.message.role === "user");
}

function toolCalls(responses: readonly AssistantMessage[]): ToolCall[] {
	return responses.flatMap((message) => message.content.filter((part): part is ToolCall => part.type === "toolCall"));
}

function createRecordedTools(
	calls: readonly ToolCall[],
	results: readonly ToolResultMessage[],
): { tools: AgentTool[]; assertExhausted(): void } {
	const resultByCallId = new Map(results.map((result) => [result.toolCallId, structuredClone(result)]));
	const unconsumed = new Set(resultByCallId.keys());
	const tools = [...new Set(calls.map((call) => call.name))].map(
		(name): AgentTool => ({
			name,
			label: `Recorded ${name}`,
			description: "Replays a recorded tool result without external side effects.",
			parameters: Type.Any(),
			execute: async (toolCallId): Promise<AgentToolResult<unknown>> => {
				const result = resultByCallId.get(toolCallId);
				if (!result) throw new Error(`Missing recorded tool result for ${toolCallId}`);
				unconsumed.delete(toolCallId);
				if (result.isError) {
					const text = result.content.find((part) => part.type === "text")?.text ?? "Recorded tool error";
					throw new Error(text);
				}
				return {
					content: structuredClone(result.content),
					details: structuredClone(result.details),
					usage: structuredClone(result.usage),
					addedToolNames: structuredClone(result.addedToolNames),
				};
			},
		}),
	);
	return {
		tools,
		assertExhausted() {
			if (unconsumed.size > 0) throw new Error(`Replay left ${unconsumed.size} tool result(s) unused`);
		},
	};
}

function assertResponsesMatch(actual: readonly AssistantMessage[], expected: readonly AssistantMessage[]): void {
	if (actual.length !== expected.length) {
		throw new Error(`Replayed ${actual.length} assistant response(s), expected ${expected.length}`);
	}
	for (const [index, response] of actual.entries()) {
		if (JSON.stringify(response) !== JSON.stringify(expected[index])) {
			throw new Error(`Replayed assistant response ${index + 1} does not match the recording`);
		}
	}
}

function assertToolResultsMatch(actual: readonly ToolResultMessage[], expected: readonly ToolResultMessage[]): void {
	if (actual.length !== expected.length) {
		throw new Error(`Replayed ${actual.length} tool result(s), expected ${expected.length}`);
	}
	for (const [index, result] of actual.entries()) {
		const recorded = expected[index];
		if (!recorded) throw new Error(`Missing recorded tool result ${index + 1}`);
		const { timestamp: _actualTimestamp, ...actualStable } = result;
		const { timestamp: _recordedTimestamp, ...recordedStable } = recorded;
		const actualComparable = { ...actualStable };
		const recordedComparable = { ...recordedStable };
		if (
			actualComparable.details === undefined ||
			(typeof actualComparable.details === "object" && Object.keys(actualComparable.details ?? {}).length === 0)
		)
			delete actualComparable.details;
		if (
			recordedComparable.details === undefined ||
			(typeof recordedComparable.details === "object" && Object.keys(recordedComparable.details ?? {}).length === 0)
		)
			delete recordedComparable.details;
		if (JSON.stringify(actualComparable) !== JSON.stringify(recordedComparable)) {
			throw new Error(`Replayed tool result ${index + 1} does not match the recording`);
		}
	}
}

function productionPromptAndSchemas(toolNames: readonly string[]): { systemPrompt: string; tools: Tool[] } {
	const definitions = createAllToolDefinitions("$HOME/replay-fixtures");
	const defaultToolNames = ["read", "bash", "edit", "write"];
	const selected = [...new Set([...defaultToolNames, ...toolNames])].sort().flatMap((name) => {
		const definition = Reflect.get(definitions, name);
		return definition && typeof definition === "object" ? [definition] : [];
	});
	const toolSnippets = Object.fromEntries(
		selected.flatMap((definition) =>
			typeof definition.promptSnippet === "string" ? [[definition.name, definition.promptSnippet]] : [],
		),
	);
	const promptGuidelines = selected.flatMap((definition) => definition.promptGuidelines ?? []);
	return {
		systemPrompt: buildSystemPrompt({
			cwd: "$HOME/replay-fixtures",
			customPrompt: "You are an expert coding assistant operating inside Apex Code.",
			selectedTools: selected.map((definition) => definition.name),
			toolSnippets,
			promptGuidelines,
		}),
		tools: selected.map((definition) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
		})),
	};
}

export async function replay(filePath: string): Promise<ReplayResult> {
	let physicalLines: unknown[];
	try {
		physicalLines = readFileSync(filePath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line));
	} catch (error) {
		throw new Error(`Replay requires valid JSONL: ${filePath}`, { cause: error });
	}
	const fileEntries = loadEntriesFromFile(filePath);
	if (physicalLines.length !== fileEntries.length) throw new Error("Replay session contains an invalid physical line");
	if (!isVersionThreeHeader(fileEntries[0])) {
		throw new Error(`Replay requires a native version 3 session: ${filePath}`);
	}
	const rawEntries = fileEntries.slice(1);
	const rawSessionEntries = rawEntries.filter(isSessionEntry);
	if (rawSessionEntries.length !== rawEntries.length) throw new Error("Replay session contains an invalid entry");
	validateSessionTree(rawSessionEntries);
	const sessionManager = SessionManager.open(filePath);
	const entries = sessionManager.getBranch();
	validateSessionTree(entries);
	const responses = selectedResponses(entries);
	const recordedToolResults = selectedToolResults(entries);
	const users = selectedUserEntries(entries);
	if (users.length === 0 || responses.length === 0)
		throw new Error("Replay session must contain user and assistant messages");

	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const recorded = registerRecordedProvider(runtime, responses);
	const recordedTools = createRecordedTools(toolCalls(responses), recordedToolResults);
	const replayedResponses: AssistantMessage[] = [];
	const replayedToolResults: ToolResultMessage[] = [];
	const contextTokensByTurn: number[] = [];
	let turnsCompleted = 0;
	const promptBaseline = productionPromptAndSchemas(recordedTools.tools.map((tool) => tool.name));
	let networkCalls = 0;
	const rejectNetwork: typeof globalThis.fetch = async () => {
		networkCalls++;
		throw new Error("Network access is disabled during replay");
	};
	const firstContext = buildSessionContext(entries, users[0]?.id);
	const firstResponse = responses[0];
	if (!firstResponse) throw new Error("Replay session has no recorded response");
	const agent = new Agent({
		initialState: {
			model: recorded.getModel(firstContext.model?.modelId ?? firstResponse.model),
			systemPrompt: promptBaseline.systemPrompt,
			tools: recordedTools.tools,
		},
		streamFn: (model, context, options) => runtime.streamSimple(model, context, { ...options, fetch: rejectNetwork }),
		getApiKey: () => "offline-replay",
		convertToLlm: (messages) => {
			const converted: Message[] = [];
			for (const message of messages) {
				if (message.role === "user") {
					converted.push({ role: "user", content: message.content, timestamp: message.timestamp });
					continue;
				}
				if (message.role === "assistant") {
					converted.push(message);
					continue;
				}
				if (message.role !== "toolResult") continue;
				const recordedResult = recordedToolResults.find((result) => result.toolCallId === message.toolCallId);
				if (!recordedResult) throw new Error(`Missing recorded tool result for ${message.toolCallId}`);
				converted.push(structuredClone(recordedResult));
			}
			return converted;
		},
		afterToolCall: async ({ toolCall }) => {
			const result = recordedToolResults.find((candidate) => candidate.toolCallId === toolCall.id);
			if (!result) throw new Error(`Missing recorded tool result for ${toolCall.id}`);
			return {
				content: structuredClone(result.content),
				details: result.details,
				usage: result.usage,
				isError: result.isError,
			};
		},
		toolExecution: "sequential",
	});

	for (const user of users) {
		const historical = buildSessionContext(entries, user.id);
		const nextResponse = responses[recorded.requestCount];
		if (!nextResponse) throw new Error(`Missing recorded response for user turn ${contextTokensByTurn.length + 1}`);
		agent.state.model = recorded.getModel(historical.model?.modelId ?? nextResponse.model);
		agent.state.messages = historical.messages.slice(0, -1);
		const requestStart = recorded.requestCount;
		await agent.prompt(user.message);
		const turnContexts = recorded.contexts.slice(requestStart);
		const lastContext = turnContexts.at(-1);
		if (!lastContext) throw new Error(`User turn ${contextTokensByTurn.length + 1} made no provider request`);
		const staticInputTokens = Math.ceil(
			`${promptBaseline.systemPrompt}\n${JSON.stringify(promptBaseline.tools)}`.length / 4,
		);
		contextTokensByTurn.push(
			staticInputTokens + lastContext.messages.reduce((total, message) => total + estimateTokens(message), 0),
		);
		for (const message of agent.state.messages.slice(historical.messages.length - 1)) {
			if (message.role === "assistant") replayedResponses.push(message);
			if (message.role === "toolResult") replayedToolResults.push(message);
		}
		const terminalResponse = replayedResponses.at(-1);
		if (terminalResponse && terminalResponse.stopReason !== "error" && terminalResponse.stopReason !== "aborted") {
			turnsCompleted++;
		}
	}
	recorded.assertExhausted();
	recordedTools.assertExhausted();
	assertResponsesMatch(replayedResponses, responses);
	assertToolResultsMatch(replayedToolResults, recordedToolResults);

	return {
		turns: users.length,
		requests: recorded.requestCount,
		networkCalls,
		responses: replayedResponses,
		toolResults: replayedToolResults.map((result, index) => ({
			...structuredClone(result),
			timestamp: recordedToolResults[index]?.timestamp ?? result.timestamp,
		})),
		metrics: buildReplayMetrics({
			systemPrompt: promptBaseline.systemPrompt,
			tools: promptBaseline.tools,
			recordedResponses: responses,
			replayedResponses,
			contextTokensByTurn,
			turnsCompleted,
		}),
	};
}

/** Replay every JSONL fixture in lexical order for byte-stable corpus output. */
export async function replayCorpus(directory: string): Promise<Record<string, ReplayMetrics>> {
	const metrics: Record<string, ReplayMetrics> = {};
	for (const name of readdirSync(directory)
		.filter((entry) => entry.endsWith(".jsonl"))
		.sort()) {
		metrics[name] = (await replay(join(directory, name))).metrics;
	}
	return metrics;
}
