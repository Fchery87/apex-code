/**
 * Assembles the MCP subsystem for one session, or returns undefined when nothing is
 * configured.
 *
 * The undefined case is the point. A session with no `.mcp.json` builds no cache, no
 * manager, and no tool, so its registry and static prompt prefix are identical to a
 * build from before this subsystem existed.
 */

import { projectResourcePathByName } from "../project-resources.ts";
import { globalMcpConfigPath, loadMcpConfig, PROJECT_CONFIG_FILENAME } from "./config.ts";
import { connectMcpServer } from "./connector.ts";
import type { McpToolOptions } from "./mcp-tool.ts";
import { McpMetadataCache } from "./metadata-cache.ts";
import { McpServerManager } from "./server-manager.ts";
import type { McpConfigDiagnostic, McpConnector } from "./types.ts";

export interface McpRuntime extends McpToolOptions {
	diagnostics: readonly McpConfigDiagnostic[];
	/**
	 * Connect each server that needs it so its tools are discoverable cold: every `eager`
	 * server, and every other server with no cache entry yet. Resolves to the names of the
	 * servers it started, so the session can tell the user what ran. A server with a cache
	 * entry is never started again.
	 */
	warm(): Promise<string[]>;
	close(): Promise<void>;
}

export function createMcpRuntime(
	cwd: string,
	connector: McpConnector = connectMcpServer,
	options: { projectTrusted: boolean; agentDir?: string },
): McpRuntime | undefined {
	// ADR 0034. Inferring trust from `!== false` meant a forgotten argument and a deliberate
	// grant were the same value, and the forgotten one started the project's eager servers.
	if (typeof options?.projectTrusted !== "boolean") {
		throw new TypeError("createMcpRuntime requires an explicit projectTrusted decision (ADR 0034)");
	}
	const { servers, diagnostics } = loadMcpConfig({
		projectPath: options.projectTrusted ? projectResourcePathByName(cwd, PROJECT_CONFIG_FILENAME) : undefined,
		globalPath: globalMcpConfigPath(options.agentDir),
	});
	if (servers.size === 0) return undefined;

	const cache = new McpMetadataCache();
	// A server removed from config stops appearing in search immediately, rather than
	// lingering until something happens to overwrite its cache entry.
	cache.prune([...servers.values()]);

	const manager = new McpServerManager({ servers, connector });

	return {
		servers,
		cache,
		manager,
		diagnostics,
		warm: async () => {
			await manager.warmEagerServers((server, tools) => cache.set(server, tools));
			const started: string[] = [];
			for (const server of servers.values()) {
				if (server.lifecycle === "eager" || cache.get(server).length > 0) continue;
				started.push(server.name);
				try {
					await manager.withConnection(server.name, async (connection) => {
						cache.set(server, await connection.listTools());
					});
				} catch {
					// Recorded as `failed` by the manager; the first real call reports it.
				}
			}
			cache.save();
			return started;
		},
		close: () => manager.closeAll(),
	};
}
