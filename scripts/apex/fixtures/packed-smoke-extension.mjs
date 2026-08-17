import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";

/**
 * Provider-independent functional smoke fixture for the packed-artifact gate
 * (ADR 0018, task 12.8). Scripts a single completed turn with no real network
 * call, proving the packed-and-installed CLI resolves its full dependency
 * graph and runs a real session through the real sandbox.
 */
export default function (pi) {
	const faux = fauxProvider({ provider: "apex-packed-smoke", models: [{ id: "scripted" }] });
	faux.setResponses([fauxAssistantMessage("apex-packed-smoke ok", { stopReason: "stop" })]);
	pi.registerProvider(faux.provider);
}
