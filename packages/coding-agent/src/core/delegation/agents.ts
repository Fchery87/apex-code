/** Markdown agent-definition discovery (roadmap Phase 5, task 5.5).
 * User definitions are always eligible. Project definitions are eligible only
 * through the existing project-trust decision; discovery never prompts or creates
 * a second trust mechanism. Files are parsed on lookup so edits take effect on the
 * next delegation and malformed definitions simply remain unavailable.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
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

export function createAgentDefinitionResolver(options: CreateAgentDefinitionResolverOptions): AgentDefinitionResolver {
	const userDir = join(options.agentDir, "agents");
	const projectDir = join(options.cwd, ".apex-code", "agents");
	return (agentType) =>
		discover(userDir, agentType) ?? (options.isProjectTrusted() ? discover(projectDir, agentType) : undefined);
}
