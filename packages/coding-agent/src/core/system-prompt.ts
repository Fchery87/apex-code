/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, SKILL_CATALOG_PREFIX_BUDGET_TOKENS, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the Apex-authored prose, not the tool contributions). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets contributed by active tools and extensions. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

function dedupeGuidelines(guidelines: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length === 0 || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const hasRead = tools.includes("read");

	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList = visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n");

	// Contributed by the active tools and extensions, so they survive a custom prompt.
	const contributedGuidelines = dedupeGuidelines(promptGuidelines ?? []);

	let prompt: string;

	if (customPrompt) {
		prompt = customPrompt;

		if (toolsList.length > 0) {
			prompt += `\n\nAvailable tools:\n${toolsList}`;
		}

		if (contributedGuidelines.length > 0) {
			prompt += `\n\nGuidelines:\n${contributedGuidelines.map((g) => `- ${g}`).join("\n")}`;
		}
	} else {
		const hasBash = tools.includes("bash");
		const hasPowerShell = tools.includes("powershell");
		const hasGrep = tools.includes("grep");
		const hasFind = tools.includes("find");
		const hasLs = tools.includes("ls");
		const usesShellForExploration = (hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs;
		const shellExplorationGuideline =
			hasBash && hasPowerShell
				? "Use bash or PowerShell for file operations like listing, searching, and finding files"
				: hasPowerShell
					? "Use PowerShell for file operations like listing, searching, and finding files"
					: "Use bash for file operations like ls, rg, find";

		const guidelines = dedupeGuidelines([
			...(usesShellForExploration ? [shellExplorationGuideline] : []),
			...contributedGuidelines,
			"Be concise in your responses",
			"Show file paths clearly when working with files",
		])
			.map((g) => `- ${g}`)
			.join("\n");

		const readmePath = getReadmePath();
		const docsPath = getDocsPath();
		const examplesPath = getExamplesPath();

		prompt = `You are an expert coding assistant operating inside Apex Code, a provider-agnostic coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList.length > 0 ? toolsList : "(none)"}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Apex Code documentation (read only when the user asks about Apex Code itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading Apex Code docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on Apex Code topics, read the docs and examples, and follow .md cross-references before implementing
- Always read Apex Code .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSystemPrompt) {
		prompt += `\n\n${appendSystemPrompt}`;
	}

	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills, SKILL_CATALOG_PREFIX_BUDGET_TOKENS);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
