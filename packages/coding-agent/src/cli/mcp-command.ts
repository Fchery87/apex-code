import chalk from "chalk";
import { authorizeConfiguredServer } from "../core/mcp/oauth/authorize.ts";
import type { runMcpOAuthFlow } from "../core/mcp/oauth/flow.ts";

export function printMcpCommandHelp(): void {
	console.log(`Usage:
  apex-code mcp auth <server>

Runs the OAuth authorization flow for one MCP server configured with "auth": "oauth"
in .mcp.json. The authorization URL is printed and opened in a browser; the callback
is served on 127.0.0.1 only while the flow runs. Tokens are stored in the host
credential store (auth.json), never in the project.`);
}

export async function runMcpCommand(
	args: string[],
	options: {
		cwd?: string;
		openBrowser?: (url: string) => void;
		/** Injectable flow, for tests. */
		flow?: typeof runMcpOAuthFlow;
	} = {},
): Promise<boolean> {
	if (args[0] !== "mcp") return false;
	const subcommand = args[1];
	if (subcommand === undefined || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		printMcpCommandHelp();
		return true;
	}
	if (subcommand !== "auth") {
		console.error(chalk.red(`Error: Unknown mcp command "${subcommand}".`));
		printMcpCommandHelp();
		process.exitCode = 1;
		return true;
	}
	const serverName = args[2];
	if (!serverName) {
		console.error(chalk.red("Error: mcp auth requires a server name."));
		printMcpCommandHelp();
		process.exitCode = 1;
		return true;
	}
	if (args.length > 3) {
		console.error(chalk.red("Error: mcp auth only accepts a server name."));
		process.exitCode = 1;
		return true;
	}
	try {
		await authorizeConfiguredServer({
			serverName,
			cwd: options.cwd,
			openBrowser: options.openBrowser,
			flow: options.flow,
			log: (line) => console.log(line),
		});
	} catch (error) {
		console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
		process.exitCode = 1;
	}
	return true;
}
