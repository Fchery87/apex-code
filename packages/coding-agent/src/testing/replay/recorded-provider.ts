import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";

const RECORDED_PROVIDER_ID = "recorded";
const RECORDED_API = "apex-recorded";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface RecordedProvider {
	readonly requestCount: number;
	readonly contexts: readonly import("@earendil-works/pi-ai").Context[];
	getModel(modelId: string): Model<string>;
	assertExhausted(): void;
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const cloned = structuredClone(message);
		stream.push({ type: "start", partial: { ...cloned, content: [] } });
		if (cloned.stopReason === "error" || cloned.stopReason === "aborted") {
			stream.push({ type: "error", reason: cloned.stopReason, error: cloned });
		} else if (cloned.stopReason === "pending") {
			const error = errorMessage("Recorded response cannot have a pending stop reason", cloned.model);
			stream.push({ type: "error", reason: "error", error });
			stream.end(error);
			return;
		} else {
			stream.push({ type: "done", reason: cloned.stopReason, message: cloned });
		}
		stream.end(cloned);
	});
	return stream;
}

function errorMessage(message: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: RECORDED_API,
		provider: RECORDED_PROVIDER_ID,
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { ...ZERO_COST, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: 0,
	};
}

function failedStream(message: string, modelId: string): AssistantMessageEventStream {
	return completedStream(errorMessage(message, modelId));
}

function recordedModel(modelId: string): Model<string> {
	return {
		id: modelId,
		name: modelId,
		api: RECORDED_API,
		provider: RECORDED_PROVIDER_ID,
		baseUrl: "replay://recorded",
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 100_000,
	};
}

export function registerRecordedProvider(
	runtime: ModelRuntime,
	responses: readonly AssistantMessage[],
): RecordedProvider {
	const pending = responses.map((message) => structuredClone(message));
	const modelIds = [...new Set(pending.map((message) => message.model))];
	const models = new Map(modelIds.map((modelId) => [modelId, recordedModel(modelId)]));
	let requestCount = 0;
	const contexts: import("@earendil-works/pi-ai").Context[] = [];

	runtime.registerProvider(RECORDED_PROVIDER_ID, {
		name: "Recorded replay provider",
		api: RECORDED_API,
		apiKey: "offline-replay",
		models: [...models.values()],
		streamSimple: (model, context) => {
			requestCount++;
			contexts.push({
				systemPrompt: context.systemPrompt,
				messages: structuredClone(context.messages),
			});
			const response = pending.shift();
			if (!response) return failedStream(`Recorded replay exhausted before request ${requestCount}`, model.id);
			if (response.model !== model.id) {
				return failedStream(`Recorded model mismatch: expected ${response.model}, received ${model.id}`, model.id);
			}
			return completedStream(response);
		},
	});

	return {
		get requestCount() {
			return requestCount;
		},
		get contexts() {
			return contexts;
		},
		getModel(modelId) {
			const model = models.get(modelId);
			if (!model) throw new Error(`Unknown recorded model: ${modelId}`);
			return model;
		},
		assertExhausted() {
			if (pending.length > 0) throw new Error(`Recorded replay left ${pending.length} response(s) unused`);
		},
	};
}
