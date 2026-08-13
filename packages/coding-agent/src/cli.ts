#!/usr/bin/env node
import { dirname } from "node:path";
/** The public CLI either supervises a sandbox child or starts an ordinary runtime. */
import { fileURLToPath } from "node:url";
import { APP_NAME, getPackageDir } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { requiresSandboxedChild } from "./core/sandbox/cli-launch.ts";
import { launchSandboxedCli } from "./core/sandbox/cli-supervisor.ts";
import { SettingsManager } from "./core/settings-manager.ts";

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	if (requiresSandboxedChild(args)) {
		const settingsManager = SettingsManager.create(process.cwd());
		const allowedHosts = settingsManager.getNetworkSettings()?.allowedHosts;

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
			readOnlyPaths: [getPackageDir(), dirname(getPackageDir())],
		});
		return;
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "apex-code";
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	configureHttpDispatcher();
	const { main } = await import("./main.ts");
	await main(args);
}

await run();
