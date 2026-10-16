/** Markdown agent-definition discovery (roadmap Phase 5, task 5.5).
 * User definitions are always eligible. Project definitions are eligible only
 * through the existing project-trust decision; discovery never prompts or creates
 * a second trust mechanism. Files are parsed on lookup so edits take effect on the
 * next delegation and malformed definitions simply remain unavailable.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { PROJECT_AGENTS_DIR, projectResourcePathByName } from "../project-resources.ts";
import type { AgentDefinition, AgentDefinitionResolver } from "./runtime.ts";

interface AgentFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
}

export interface CreateAgentDefinitionResolverOptions {
	cwd: string;
	agentDir: string;
	/** Delegated to SettingsManager.isProjectTrusted() in production. */
	isProjectTrusted: () => boolean;
}

function parseDefinition(content: string): AgentDefinition | undefined {
	try {
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (
			typeof frontmatter.name !== "string" ||
			!frontmatter.name ||
			typeof frontmatter.description !== "string" ||
			!frontmatter.description ||
			!Array.isArray(frontmatter.tools) ||
			!frontmatter.tools.every((tool): tool is string => typeof tool === "string" && tool.length > 0) ||
			(frontmatter.model !== undefined && (typeof frontmatter.model !== "string" || !frontmatter.model))
		)
			return undefined;
		return {
			name: frontmatter.name,
			description: frontmatter.description,
			tools: [...frontmatter.tools],
			model: frontmatter.model,
			systemPrompt: body,
		};
	} catch {
		return undefined;
	}
}

function discover(dir: string, agentType: string): AgentDefinition | undefined {
	if (!existsSync(dir)) return undefined;
	try {
		for (const filename of readdirSync(dir).sort()) {
			if (!filename.endsWith(".md")) continue;
			const definition = parseDefinition(readFileSync(join(dir, filename), "utf8"));
			if (definition?.name === agentType) return definition;
		}
	} catch {
		// A directory that cannot be read behaves as having no usable definitions.
	}
	return undefined;
}

/**
 * Shipped with the harness. A user or trusted-project definition with the same name replaces
 * one of these. Neither can grant more than the parent holds: the runtime's capability
 * ceiling checks every tool name here as it checks any other definition.
 *
 * `general` leaves out `delegate`, so a child never spawns children of its own. It also
 * leaves out `web_fetch`, because it needs network authority that a parent without
 * `web_fetch` active does not hold, and requesting it would refuse the whole delegation.
 */
export const BUILT_IN_AGENT_DEFINITIONS: readonly AgentDefinition[] = [
	{
		name: "explore",
		description:
			"Read-only search of the workspace: find files, grep contents, and list directories. Cannot edit files or run commands.",
		tools: ["read", "grep", "find", "ls"],
		systemPrompt:
			"You search and read code to answer a question. You cannot change files or run commands. Report the file paths and line numbers that answer the question, and say plainly when the answer is not in the workspace.",
	},
	{
		name: "general",
		description: "General-purpose helper with the default file and shell tools. Cannot delegate further.",
		tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "todo_write"],
		systemPrompt:
			"You complete the task you are given using the tools available to you. Keep changes to what the task requires, and report what you changed and what you verified.",
	},
];

export interface AgentDefinitionSummary {
	name: string;
	description: string;
	source: "user" | "project" | "built-in";
}

/** A resolver that can also list what it would resolve, so the model can be told which types exist. */
export type AgentDefinitionCatalogResolver = AgentDefinitionResolver & {
	list(): AgentDefinitionSummary[];
};

function discoverAll(dir: string): AgentDefinition[] {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.sort()
			.filter((filename) => filename.endsWith(".md"))
			.map((filename) => parseDefinition(readFileSync(join(dir, filename), "utf8")))
			.filter((definition): definition is AgentDefinition => definition !== undefined);
	} catch {
		return [];
	}
}

export function createAgentDefinitionResolver(
	options: CreateAgentDefinitionResolverOptions,
): AgentDefinitionCatalogResolver {
	const userDir = join(options.agentDir, "agents");
	const projectDir = projectResourcePathByName(options.cwd, PROJECT_AGENTS_DIR);
	const projectTrusted = () => options.isProjectTrusted();
	const resolve = ((agentType: string) =>
		discover(userDir, agentType) ??
		(projectTrusted() ? discover(projectDir, agentType) : undefined) ??
		BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.name === agentType)) as AgentDefinitionCatalogResolver;
	resolve.list = () => {
		const seen = new Map<string, AgentDefinitionSummary>();
		const add = (definitions: readonly AgentDefinition[], source: AgentDefinitionSummary["source"]) => {
			for (const definition of definitions) {
				if (!seen.has(definition.name)) {
					seen.set(definition.name, { name: definition.name, description: definition.description, source });
				}
			}
		};
		add(discoverAll(userDir), "user");
		if (projectTrusted()) add(discoverAll(projectDir), "project");
		add(BUILT_IN_AGENT_DEFINITIONS, "built-in");
		return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
	};
	return resolve;
}
