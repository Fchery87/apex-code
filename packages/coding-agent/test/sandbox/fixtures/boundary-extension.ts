import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "apex-code";

/**
 * Test-only extension: scripts a fixed tool-call sequence with no real network
 * call, so a live-agent boundary test can drive real bash/write tool execution
 * through the actual CLI entry point instead of a raw shell command.
 */
export default function (pi: ExtensionAPI) {
	const outsideBash = process.env.APEX_BOUNDARY_TEST_OUTSIDE_BASH ?? "";
	const outsideWrite = process.env.APEX_BOUNDARY_TEST_OUTSIDE_WRITE ?? "";

	const faux = fauxProvider({ provider: "boundary-test", models: [{ id: "scripted" }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: `printf blocked > ${outsideBash}` })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("write", { path: outsideWrite, content: "blocked" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);

	pi.registerProvider(faux.provider);
}
