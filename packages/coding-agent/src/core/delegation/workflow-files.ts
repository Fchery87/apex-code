import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";

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

function symlinkReason(path: string): string | undefined {
	try {
		if (lstatSync(path).isSymbolicLink()) return `${path} is a symlink (${readlinkSync(path)})`;
	} catch {
		return undefined;
	}
	return undefined;
}

export function loadWorkflowScripts(dir: string): WorkflowLoadResult {
	const scripts: WorkflowScript[] = [];
	const diagnostics: string[] = [];
	const linked = symlinkReason(dir);
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
		scripts.push({
			name: parsed.frontmatter.name,
			description: parsed.frontmatter.description,
			body: parsed.body.trim(),
			path: resolve(path),
		});
	}
	return { scripts, diagnostics };
}
