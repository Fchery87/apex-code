import { readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "apex-code";

/**
 * Test-only extension: proves the sandboxed child can read the host-projected,
 * read-only credential file end to end through the real CLI entry point, and that
 * an attempted write to it fails rather than silently succeeding or crashing the
 * turn. No real provider network call is made.
 */
export default function (pi: ExtensionAPI) {
	const authPath = process.env.APEX_CODE_AUTH_PATH ?? "";
	// Arbitrary custom env vars do not cross the sandbox boundary (only an explicit
	// allowlist does, per ADR 0015/0016), so the result is written to a fixed path
	// relative to the child's workspace cwd instead.
	const resultPath = "credential-boundary-result.json";

	let readValue: string;
	try {
		readValue = readFileSync(authPath, "utf8");
	} catch (error) {
		readValue = `read-failed: ${error instanceof Error ? error.message : String(error)}`;
	}

	let writeOutcome: "rejected" | "succeeded";
	try {
		writeFileSync(authPath, "tampered-from-sandbox");
		writeOutcome = "succeeded";
	} catch {
		writeOutcome = "rejected";
	}

	writeFileSync(resultPath, JSON.stringify({ readValue, writeOutcome }));

	const faux = fauxProvider({ provider: "credential-boundary-test", models: [{ id: "scripted" }] });
	faux.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
	pi.registerProvider(faux.provider);
}
