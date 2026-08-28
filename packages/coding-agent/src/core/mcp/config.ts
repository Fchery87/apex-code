/**
 * Reads the ecosystem-standard `{ "mcpServers": { … } }` shape from a project
 * `.mcp.json` and a global `mcp.json`, project winning per server name.
 *
 * Every failure degrades. A malformed file yields no servers and one diagnostic; a
 * malformed entry drops itself and leaves its siblings intact. A config file is the
 * first thing a user hand-edits, so a parse error must never take the session down.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { ALL_CAPABILITIES, type Capability } from "../tools/contract.ts";
import {
	DEFAULT_IDLE_TIMEOUT_MINUTES,
	DEFAULT_LIFECYCLE,
	type McpConfig,
	type McpConfigDiagnostic,
	type McpLifecycle,
	type McpServerConfig,
	type McpTransport,
} from "./types.ts";

const LIFECYCLES: readonly McpLifecycle[] = ["lazy", "eager", "keep-alive", "lazy-keep-alive"];

export const PROJECT_CONFIG_FILENAME = ".mcp.json";

export function globalMcpConfigPath(): string {
	return join(homedir(), CONFIG_DIR_NAME, "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item;
	}
	return out;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseTransport(entry: Record<string, unknown>): McpTransport | string {
	const command = typeof entry.command === "string" ? entry.command : undefined;
	const url = typeof entry.url === "string" ? entry.url : undefined;

	if (command && url) return "declares both command and url; exactly one is required";
	if (command) {
		return {
			kind: "stdio",
			command,
			args: stringArray(entry.args),
			env: stringRecord(entry.env),
			cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
		};
	}
	if (url) {
		return {
			kind: "http",
			url,
			headers: stringRecord(entry.headers),
			bearerTokenEnv: typeof entry.bearerTokenEnv === "string" ? entry.bearerTokenEnv : undefined,
		};
	}
	return "declares neither command nor url";
}

/**
 * An absent `capabilities` is the common case, not an edge case: a config pasted from
 * another host carries no Apex-specific field. Those servers get the full set, which
 * keeps them classified (never `UNCLASSIFIED`) without narrowing anything the user
 * did not ask to narrow.
 */
function parseCapabilities(entry: Record<string, unknown>, report: (message: string) => void): ReadonlySet<Capability> {
	if (!("capabilities" in entry)) return ALL_CAPABILITIES;
	if (!Array.isArray(entry.capabilities)) {
		report("capabilities is not an array; falling back to the full capability set");
		return ALL_CAPABILITIES;
	}

	const resolved = new Set<Capability>();
	const unknown: string[] = [];
	for (const candidate of entry.capabilities) {
		if (typeof candidate === "string" && ALL_CAPABILITIES.has(candidate as Capability)) {
			resolved.add(candidate as Capability);
		} else {
			unknown.push(String(candidate));
		}
	}
	if (unknown.length > 0) report(`unknown capabilities dropped: ${unknown.join(", ")}`);
	return resolved;
}

function parseLifecycle(entry: Record<string, unknown>, report: (message: string) => void): McpLifecycle {
	const value = entry.lifecycle;
	if (value === undefined) return DEFAULT_LIFECYCLE;
	if (typeof value === "string" && LIFECYCLES.includes(value as McpLifecycle)) return value as McpLifecycle;
	report(`unknown lifecycle ${JSON.stringify(value)}; using ${DEFAULT_LIFECYCLE}`);
	return DEFAULT_LIFECYCLE;
}

function parseIdleTimeout(entry: Record<string, unknown>): number {
	const value = entry.idleTimeout;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_IDLE_TIMEOUT_MINUTES;
}

function readServers(path: string, diagnostics: McpConfigDiagnostic[]): Map<string, McpServerConfig> {
	const servers = new Map<string, McpServerConfig>();
	if (!existsSync(path)) return servers;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		diagnostics.push({
			path,
			server: undefined,
			message: `could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
		});
		return servers;
	}

	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		diagnostics.push({ path, server: undefined, message: "has no mcpServers object" });
		return servers;
	}

	for (const [name, raw] of Object.entries(parsed.mcpServers)) {
		if (!isRecord(raw)) {
			diagnostics.push({ path, server: name, message: "entry is not an object" });
			continue;
		}
		const transport = parseTransport(raw);
		if (typeof transport === "string") {
			diagnostics.push({ path, server: name, message: transport });
			continue;
		}
		const report = (message: string) => diagnostics.push({ path, server: name, message });
		servers.set(name, {
			name,
			transport,
			capabilities: parseCapabilities(raw, report),
			lifecycle: parseLifecycle(raw, report),
			idleTimeoutMinutes: parseIdleTimeout(raw),
		});
	}

	return servers;
}

export function loadMcpConfig(options: { projectPath?: string; globalPath?: string } = {}): McpConfig {
	const diagnostics: McpConfigDiagnostic[] = [];
	const globalPath = options.globalPath ?? globalMcpConfigPath();

	const servers = readServers(globalPath, diagnostics);
	if (options.projectPath) {
		for (const [name, config] of readServers(options.projectPath, diagnostics)) {
			servers.set(name, config);
		}
	}

	return { servers, diagnostics };
}
