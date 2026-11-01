import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { parseWorkflowDefinition, type WorkflowDefinition } from "./workflow-definition.ts";

/**
 * Saved workflow scripts (spec 2026-10-26). A file is frontmatter plus a
 * script body. The loader reads it. It never executes it. A symlink at the
 * directory or the file is refused, so a save cannot be redirected.
 */

export interface WorkflowScript {
	name: string;
	description: string;
	body: string;
	path: string;
}

export interface WorkflowLoadResult {
	scripts: WorkflowScript[];
	diagnostics: string[];
}

export interface WorkflowDefinitionFile {
	name: string;
	description: string;
	definition: WorkflowDefinition;
	path: string;
}

export interface WorkflowDefinitionLoadResult {
	definitions: WorkflowDefinitionFile[];
	diagnostics: string[];
}

const WORKFLOW_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function assertWorkflowIdentifier(value: unknown, kind: string): asserts value is string {
	if (typeof value !== "string" || !WORKFLOW_IDENTIFIER.test(value)) {
		throw new Error(`Invalid workflow ${kind} identifier. Use a letter followed by letters, numbers, _ or -.`);
	}
}

function symlinkReason(path: string): string | undefined {
	try {
		if (lstatSync(path).isSymbolicLink()) return `${path} is a symlink (${readlinkSync(path)})`;
	} catch {
		return undefined;
	}
	return undefined;
}

function workflowDirectorySymlinkReason(dir: string): string | undefined {
	const parent = dirname(resolve(dir));
	return (basename(parent) === ".apex-code" ? symlinkReason(parent) : undefined) ?? symlinkReason(dir);
}

export function loadWorkflowScripts(dir: string): WorkflowLoadResult {
	const scripts: WorkflowScript[] = [];
	const diagnostics: string[] = [];
	const linked = workflowDirectorySymlinkReason(dir);
	if (linked) return { scripts, diagnostics: [linked] };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { scripts, diagnostics };
	}
	for (const name of names.filter((entry) => entry.endsWith(".js")).sort()) {
		const path = join(dir, name);
		const reason = symlinkReason(path);
		if (reason) {
			diagnostics.push(reason);
			continue;
		}
		let parsed: { frontmatter: { name?: unknown; description?: unknown }; body: string };
		try {
			parsed = parseFrontmatter(readFileSync(path, "utf8"));
		} catch (error) {
			diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (typeof parsed.frontmatter.name !== "string" || typeof parsed.frontmatter.description !== "string") {
			diagnostics.push(`${path}: needs a name and a description`);
			continue;
		}
		try {
			assertWorkflowIdentifier(parsed.frontmatter.name, "workflow");
		} catch (error) {
			diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		scripts.push({
			name: parsed.frontmatter.name,
			description: parsed.frontmatter.description,
			body: parsed.body.trim(),
			path: resolve(path),
		});
	}
	return { scripts, diagnostics };
}

export function resolveWorkflowScript(cwd: string, name: string): WorkflowScript {
	assertWorkflowIdentifier(name, "workflow");
	const loaded = loadWorkflowScripts(join(resolve(cwd), ".apex-code", "workflows"));
	const matches = loaded.scripts.filter((script) => script.name === name);
	if (matches.length > 1) throw new Error(`Workflow name "${name}" is ambiguous. Remove duplicate saved definitions.`);
	const script = matches[0];
	if (!script) {
		const diagnostic = loaded.diagnostics.find((entry) => entry.includes(name));
		throw new Error(diagnostic ?? `Saved workflow "${name}" was not found.`);
	}
	return script;
}

export function loadWorkflowDefinitions(dir: string): WorkflowDefinitionLoadResult {
	const definitions: WorkflowDefinitionFile[] = [];
	const diagnostics: string[] = [];
	const linked = workflowDirectorySymlinkReason(dir);
	if (linked) return { definitions, diagnostics: [linked] };
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { definitions, diagnostics };
	}
	for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
		const path = join(dir, name);
		const reason = symlinkReason(path);
		if (reason) {
			diagnostics.push(reason);
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw new Error("definition file must be an object");
			const record = parsed as Record<string, unknown>;
			assertWorkflowIdentifier(record.name, "workflow");
			if (typeof record.description !== "string" || record.description.length === 0) {
				throw new Error("definition file needs a description");
			}
			const definition = parseWorkflowDefinition(record.definition);
			definitions.push({ name: record.name, description: record.description, definition, path: resolve(path) });
		} catch (error) {
			diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { definitions, diagnostics };
}

export function resolveWorkflowDefinition(cwd: string, name: string): WorkflowDefinitionFile {
	assertWorkflowIdentifier(name, "workflow");
	const loaded = loadWorkflowDefinitions(join(resolve(cwd), ".apex-code", "workflows"));
	const matches = loaded.definitions.filter((definition) => definition.name === name);
	if (matches.length > 1) throw new Error(`Workflow name "${name}" is ambiguous. Remove duplicate saved definitions.`);
	const definition = matches[0];
	if (!definition) {
		const legacy = loadWorkflowScripts(join(resolve(cwd), ".apex-code", "workflows"));
		const legacyScript = legacy.scripts.find((script) => script.name === name);
		if (legacyScript) throw new Error(`${WORKFLOW_MIGRATION_MESSAGE} Found legacy source at ${legacyScript.path}.`);
		const legacyDiagnostic = legacy.diagnostics[0];
		if (legacyDiagnostic) throw new Error(`${WORKFLOW_MIGRATION_MESSAGE} ${legacyDiagnostic}`);
		throw new Error(`Saved workflow "${name}" was not found.`);
	}
	return definition;
}

const WORKFLOW_MIGRATION_MESSAGE =
	"Legacy JavaScript workflows are not supported. Save a versioned JSON definition instead.";
