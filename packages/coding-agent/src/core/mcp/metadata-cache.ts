/**
 * Persistent MCP tool metadata, so search and describe answer without a running
 * server. Everything the cache holds is producible from a past connection, which is
 * what makes "no server needed to search" a property rather than a convention.
 *
 * One file for every server, not one per server: the whole cache is read once at
 * session start and written whole, and a handful of servers never makes that costly.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { CachedTool, McpServerConfig, McpTransport } from "./types.ts";

interface CacheFile {
	version: 1;
	servers: Record<string, { name: string; tools: CachedTool[] }>;
}

const EMPTY: CacheFile = { version: 1, servers: {} };

const SEPARATOR = "|";

export function mcpCachePath(): string {
	return join(getAgentDir(), "mcp", "metadata.json");
}

/**
 * Identity is the launch spec alone. A server upgraded to a new version produces a
 * different key and therefore reads no stale entries, while a change to something
 * that cannot affect the tool list (capabilities, idle timeout) leaves the key alone.
 */
function transportIdentity(transport: McpTransport): string {
	if (transport.kind === "stdio") {
		const env = Object.keys(transport.env).sort().join(",");
		return ["stdio", transport.command, transport.args.join(" "), env, transport.cwd ?? ""].join(SEPARATOR);
	}
	return ["http", transport.url].join(SEPARATOR);
}

export function serverCacheKey(server: McpServerConfig): string {
	return createHash("sha256").update(transportIdentity(server.transport)).digest("hex").slice(0, 32);
}

export class McpMetadataCache {
	private file: CacheFile;
	private readonly path: string;

	constructor(path: string = mcpCachePath()) {
		this.path = path;
		this.file = McpMetadataCache.read(path);
	}

	private static read(path: string): CacheFile {
		if (!existsSync(path)) return structuredClone(EMPTY);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
			if (parsed?.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) {
				return structuredClone(EMPTY);
			}
			return parsed;
		} catch {
			return structuredClone(EMPTY);
		}
	}

	get(server: McpServerConfig): CachedTool[] {
		return this.file.servers[serverCacheKey(server)]?.tools ?? [];
	}

	all(): CachedTool[] {
		return Object.values(this.file.servers).flatMap((entry) => entry.tools);
	}

	set(server: McpServerConfig, tools: readonly CachedTool[]): void {
		this.file.servers[serverCacheKey(server)] = { name: server.name, tools: [...tools] };
	}

	/** Forget every server absent from `configured`, so a removed server stops appearing in search. */
	prune(configured: readonly McpServerConfig[]): void {
		const live = new Set(configured.map(serverCacheKey));
		for (const key of Object.keys(this.file.servers)) {
			if (!live.has(key)) delete this.file.servers[key];
		}
	}

	save(): void {
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true });
		const temporary = join(directory, `.metadata.${process.pid}.tmp`);
		try {
			writeFileSync(temporary, JSON.stringify(this.file));
			renameSync(temporary, this.path);
		} catch {
			rmSync(temporary, { force: true });
		}
	}
}
