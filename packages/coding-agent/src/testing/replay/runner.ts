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
import type { ContractLookup } from "../../core/context/eviction.ts";
import { installContextPipeline } from "../../core/context/pipeline.ts";
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
import { createAllToolDefinitions, type ToolDef } from "../../core/tools/index.ts";
import { buildReplayMetrics, type ReplayMetrics } from "./metrics.ts";
import { registerRecordedProvider } from "./recorded-provider.ts";

export interface ReplayResult {
	turns: number;
	requests: number;
	networkCalls: number;
	responses: AssistantMessage[];
	toolResults: ToolResultMessage[];
	metrics: ReplayMetrics;
	/**
	 * The final outbound provider request's messages for each user turn — the same
	 * array `contextTokensByTurn` is measured from, exposed so tests can assert
	 * directly on context-pipeline effects (eviction markers, deferred schemas)
	 * without reaching into `RecordedProvider` internals.
	 */
	contextsByTurn: Message[][];
}

/**
 * Dedicated eviction budget for the replay harness — deliberately **not** derived
 * from the fixture model's `contextWindow` (`recorded-provider.ts` hardcodes
 * `1_000_000` for unrelated reasons predating this pipeline, shared by every
 * fixture in the corpus, and is not to be changed here). Feeding that real
 * `contextWindow` through production's `evictionBudget` formula
 * (`../../core/context/pipeline.ts`) would yield a budget of roughly 490,000 tokens
 * — orders of magnitude above anything in this corpus, so eviction would never
 * observably fire and the gate it is meant to measure would stay blind, which is
 * exactly the gap this task closes.
 *
 * `1_000` was chosen empirically — measured directly against `replayCorpus()`, not
 * estimated — against three constraints that all have to hold simultaneously:
 *
 *  - `tool-error-recovery.jsonl`'s single turn carries its entire ~759 tokens
 *    (mostly the static system prompt/tool-schema prefix) under budget, so its
 *    recorded `contextTokensByTurn: [759]` (`test/replay-runner.test.ts`) is
 *    unaffected — confirmed unchanged at this budget.
 *  - `heavy-tool-output.jsonl` carries a single ~8,400-token recoverable `read`
 *    result — comfortably over budget, so it evicts, which is the fixture's
 *    documented purpose ("Large deterministic result for eviction measurements",
 *    `fixtures/corpus/README.md`). Measured post-eviction turn: 748 tokens.
 *  - `long-tool-heavy.jsonl` accumulates roughly 14,300 evictable tokens by turn 20
 *    across ten interleaved `read`/`grep` results. `1_000` was verified against
 *    `REPLAY_EVICTION_BUDGET: 0` (the theoretical floor — evict every eligible
 *    result unconditionally) and produces the *same* turn-20 result, 1,769 tokens
 *    — an 88.4% drop from the pre-pipeline baseline of 15,272 — confirming `1_000`
 *    already reaches that floor rather than under-evicting. A first pass at
 *    `3_000` measured 3,195 (79.1%, just short of the phase's 80% per-fixture
 *    goal); `1_000` was chosen after confirming the floor is actually lower.
 *
 * This constant governs replay measurement only; it has no effect on production,
 * which always calls `evictionBudget` with the real model's `contextWindow`.
 */
export const REPLAY_EVICTION_BUDGET = 1_000;

/**
 * Builds a `ContractLookup` from the real production tool definitions — a second,
 * independent call to `createAllToolDefinitions` alongside the one
 * `productionPromptAndSchemas` already makes for the static-prompt baseline. Kept
 * separate rather than threading that function's `definitions` out: the two
 * concerns (building the static prompt/schema baseline vs. resolving a tool's
 * contract for the pipeline) are unrelated, and `createAllToolDefinitions` is cheap
 * and pure, so a second call costs nothing and keeps both call sites simple.
 */
function replayContractLookup(cwd: string): ContractLookup {
	const definitions = createAllToolDefinitions(cwd);
	return (name) => (Reflect.get(definitions, name) as Partial<ToolDef> | undefined)?.contract;
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
				// Validate the call id is one this replay actually recorded, but send the
				// *incoming* message — not a fresh lookup by id — so that whatever the
				// context pipeline's eviction stage did to `message.content` upstream
				// (in `transformContext`) is what reaches the provider request. Re-fetching
				// the original recorded content here would silently discard eviction,
				// since eviction never touches `recordedToolResults` itself (see
				// `assertToolResultsMatch`, which intentionally still compares against the
				// untouched recording).
				const recordedResult = recordedToolResults.find((result) => result.toolCallId === message.toolCallId);
				if (!recordedResult) throw new Error(`Missing recorded tool result for ${message.toolCallId}`);
				converted.push(structuredClone(message));
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

	// Same pipeline `AgentSession` installs in production (`_installContextPipeline`
	// in `core/agent-session.ts`), via the shared `installContextPipeline` — deferred
	// -schema resolution ahead of every request, then tool-result eviction — so the
	// replay gate can observe both. The contract lookup is built from the real
	// production tool definitions; the budget is `REPLAY_EVICTION_BUDGET`, a
	// dedicated constant documented above (not derived from the fixture model's
	// `contextWindow`; see that constant's comment for why).
	installContextPipeline(agent, {
		contractLookup: replayContractLookup("$HOME/replay-fixtures"),
		evictionBudget: () => REPLAY_EVICTION_BUDGET,
	});

	const contextsByTurn: Message[][] = [];
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
		// Normalize toolResult timestamps to the recorded value before exposing this
		// turn's context, mirroring the same normalization the `toolResults` field
		// below already does and for the same reason: a toolResult's timestamp is
		// stamped live (via `agent.state.messages`) rather than replayed from the
		// fixture, so leaving it as-is would make `contextsByTurn` — and anything
		// that serializes it, like the determinism test below — flaky across runs.
		// Content (what eviction may have rewritten) is untouched.
		contextsByTurn.push(
			lastContext.messages.map((message) =>
				message.role === "toolResult"
					? {
							...message,
							timestamp:
								recordedToolResults.find((result) => result.toolCallId === message.toolCallId)?.timestamp ??
								message.timestamp,
						}
					: message,
			),
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
		contextsByTurn,
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
