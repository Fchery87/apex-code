import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("plan-probe", {
		api: "plan-probe-api",
		apiKey: "$APEX_TERMINAL_PROBE_TOKEN",
		baseUrl: "http://localhost/unused",
		models: [{
			id: "probe", name: "Plan approval probe", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000, maxTokens: 8192,
		}],
		streamSimple: (model, context) => {
			const stream = createAssistantMessageEventStream();
			const last = context.messages.at(-1);
			const presents = last?.role === "user";
			const content = presents
				? [fauxToolCall("plan_present", { plan: "# Terminal verification plan\n\n1. Inspect the local files.\n2. Apply the approved edit policy." })]
				: "Plan approval returned.";
			const message = {
				...fauxAssistantMessage(content),
				api: model.api, provider: model.provider, model: model.id,
				stopReason: presents ? "toolUse" as const : "stop" as const,
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
}
