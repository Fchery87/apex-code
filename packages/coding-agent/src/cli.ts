#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/** The public CLI either supervises a sandbox child or starts an ordinary runtime. */
import { fileURLToPath } from "node:url";
import { APP_NAME, getAgentDir, getPackageDir } from "./config.ts";
import { setApexEnvironment } from "./core/environment.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import {
	requiresSandboxedChild,
	resolveHostSkillPaths,
	resolveSupervisorAllowedHosts,
} from "./core/sandbox/cli-launch.ts";
import { launchSandboxedCli } from "./core/sandbox/cli-supervisor.ts";
import { prepareHostToolBinaries } from "./utils/tools-manager.ts";

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
		// Resolve fd and rg out here, where the host home and the network are both still
		// reachable. The child's own PATH still names host directories the sandbox has
		// replaced, so without this projection it finds nothing and cannot download either.
		// Silent because this runs ahead of every mode, including --print and --mode rpc,
		// whose stdout carries machine-readable output; the child still reports a genuinely
		// missing tool through its own startup path.
		const toolBinaries = await prepareHostToolBinaries(true);
		// Resolved here, where the host home is still reachable -- exactly like the
		// tool binaries above and unlike anything sourced from project files, which
		// ADR 0016 forbids as supervisor input before trust is established.
		const { paths: skillPaths, refusals: skillPathRefusals } = resolveHostSkillPaths(
			getAgentDir(),
			process.env.HOME || homedir(),
		);
		for (const refusal of skillPathRefusals) {
			process.stderr.write(`Warning: not mounting skill directory ${refusal.path}: ${refusal.reason}\n`);
		}

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
			authPath,
			readOnlyPaths: [getPackageDir(), dirname(getPackageDir())],
			toolBinaries,
			skillPaths,
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
