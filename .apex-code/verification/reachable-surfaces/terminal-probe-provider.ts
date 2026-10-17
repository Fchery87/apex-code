import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.ts";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("terminal-probe", {
		api: "terminal-probe-api",
		apiKey: "$APEX_TERMINAL_PROBE_TOKEN",
		baseUrl: "http://localhost/unused",
		models: [{
			id: "probe", name: "Terminal probe", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000, maxTokens: 8192,
		}],
		streamSimple: (model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const message = {
				...fauxAssistantMessage("Terminal probe completed."),
				api: model.api, provider: model.provider, model: model.id,
			};
			stream.push({ type: "start", partial: message });
			let finished = false;
			const finish = (aborted: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onAbort);
				if (aborted) {
					const interrupted = { ...message, content: [], stopReason: "aborted" as const };
					stream.push({ type: "error", reason: "aborted", error: interrupted });
					stream.end(interrupted);
				} else {
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				}
			};
			const onAbort = () => finish(true);
			const last = context.messages.at(-1);
			const content = last && JSON.stringify(last);
			const timer = setTimeout(() => finish(false), content?.includes("interrupt") ? 30000 : 1600);
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			if (options?.signal?.aborted) finish(true);
			return stream;
		},
	});
}
