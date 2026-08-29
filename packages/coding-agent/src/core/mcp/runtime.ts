/**
 * Assembles the MCP subsystem for one session, or returns undefined when nothing is
 * configured.
 *
 * The undefined case is the point. A session with no `.mcp.json` builds no cache, no
 * manager, and no tool, so its registry and static prompt prefix are identical to a
 * build from before this subsystem existed.
 */

import { join } from "node:path";
import { loadMcpConfig, PROJECT_CONFIG_FILENAME } from "./config.ts";
import { connectMcpServer } from "./connector.ts";
import type { McpToolOptions } from "./mcp-tool.ts";
import { McpMetadataCache } from "./metadata-cache.ts";
import { McpServerManager } from "./server-manager.ts";
import type { McpConfigDiagnostic, McpConnector } from "./types.ts";

export interface McpRuntime extends McpToolOptions {
	diagnostics: readonly McpConfigDiagnostic[];
	/** Connect `eager` servers and cache their tools, so they are discoverable cold. */
	warm(): Promise<void>;
	close(): Promise<void>;
}

export function createMcpRuntime(cwd: string, connector: McpConnector = connectMcpServer): McpRuntime | undefined {
	const { servers, diagnostics } = loadMcpConfig({ projectPath: join(cwd, PROJECT_CONFIG_FILENAME) });
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
			cache.save();
		},
		close: () => manager.closeAll(),
	};
}
