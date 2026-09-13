#!/usr/bin/env node
/** The public CLI starts an ordinary runtime. Isolation is the operator's boundary. */
import { parseCliCommand } from "./cli/args.ts";
import { APP_NAME } from "./config.ts";
import { setApexEnvironment } from "./core/environment.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	const command = parseCliCommand(args);
	// Validate session IDs before starting a runtime. Invalid metadata must fail fast
	// without loading settings, starting a session, or touching the network.
	const sessionIdIndex = args.indexOf("--session-id");
	const sessionId = sessionIdIndex >= 0 ? args[sessionIdIndex + 1] : undefined;
	if (sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
		console.error(
			"Error: Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
		process.exitCode = 1;
		return;
	}

	process.title = APP_NAME;
	setApexEnvironment("APEX_CODE_CODING_AGENT", "true");
	process.env.AI_AGENT = "apex-code";
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	configureHttpDispatcher();
	const { main } = await import("./main.ts");
	await main(args, { parsedCommand: command });
}

await run();
