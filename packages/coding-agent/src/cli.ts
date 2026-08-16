#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
/** The public CLI either supervises a sandbox child or starts an ordinary runtime. */
import { fileURLToPath } from "node:url";
import { APP_NAME, getAgentDir, getPackageDir } from "./config.ts";
import { setApexEnvironment } from "./core/environment.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { requiresSandboxedChild, resolveSupervisorAllowedHosts } from "./core/sandbox/cli-launch.ts";
import { launchSandboxedCli } from "./core/sandbox/cli-supervisor.ts";

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	// Validate session IDs before entering the sandbox. Invalid metadata must fail fast
	// without starting a child process or touching network/sandbox setup.
	const sessionIdIndex = args.indexOf("--session-id");
	const sessionId = sessionIdIndex >= 0 ? args[sessionIdIndex + 1] : undefined;
	if (sessionId !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
		console.error(
			"Error: Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
		process.exitCode = 1;
		return;
	}
	if (requiresSandboxedChild(args)) {
		const allowedHosts = resolveSupervisorAllowedHosts(process.cwd(), getAgentDir());
		const authPath = join(getAgentDir(), "auth.json");

		process.exitCode = await launchSandboxedCli({
			command: process.execPath,
			args: [
				fileURLToPath(
					new URL(`./core/sandbox/child-entry${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url),
				),
				...args,
			],
			environment: process.env,
			workspace: process.cwd(),
			allowedHosts,
			authPath: existsSync(authPath) ? authPath : undefined,
			readOnlyPaths: [getPackageDir(), dirname(getPackageDir())],
		});
		return;
	}

	process.title = APP_NAME;
	setApexEnvironment("APEX_CODE_CODING_AGENT", "true");
	process.env.AI_AGENT = "apex-code";
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	configureHttpDispatcher();
	const { main } = await import("./main.ts");
	await main(args);
}

await run();
