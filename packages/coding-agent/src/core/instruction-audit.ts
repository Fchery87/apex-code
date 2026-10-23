import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface InstructionFinding {
	kind: "missing-path" | "contradiction" | "missing-command";
	text: string;
	path: string;
}

const PATH_REF = /(?:^|\s)((?:docs|src|packages|test)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
const COMMAND = /`([a-z][a-z0-9-]*)(?:\s+([^`]*))?`/g;

function instructionFiles(dir: string): string[] {
	const found: string[] = [];
	const visit = (current: string): void => {
		for (const name of readdirSync(current)) {
			if (name === "node_modules" || name === ".git" || name === ".apex-code") continue;
			const path = join(current, name);
			const stat = statSync(path);
			if (stat.isDirectory()) visit(path);
			else if (name === "AGENTS.md" || name === "CLAUDE.md") found.push(path);
		}
	};
	if (existsSync(dir)) visit(dir);
	return found;
}

/**
 * Read instruction files and report missing paths and commands that disagree.
 * Writes nothing.
 */
export function auditInstructions(cwd: string): InstructionFinding[] {
	const findings: InstructionFinding[] = [];
	const commands = new Map<string, { args: string; path: string }>();
	for (const path of instructionFiles(cwd)) {
		const text = readFileSync(path, "utf-8");
		for (const match of text.matchAll(PATH_REF)) {
			const named = match[1];
			if (named && !existsSync(join(cwd, named))) {
				findings.push({ kind: "missing-path", text: named, path: relative(cwd, path) });
			}
		}
		for (const match of text.matchAll(COMMAND)) {
			const name = match[1];
			const args = (match[2] ?? "").trim();
			if (!name) continue;
			const prior = commands.get(name);
			if (prior && prior.args !== args) {
				findings.push({
					kind: "contradiction",
					text: `\`${name}\` is \`${prior.args || name}\` in ${prior.path} and \`${args || name}\` in ${relative(cwd, path)}`,
					path: relative(cwd, path),
				});
			} else if (!prior) {
				commands.set(name, { args, path: relative(cwd, path) });
				const found = spawnSync("which", [name], { encoding: "utf-8" });
				if (found.status !== 0) {
					findings.push({ kind: "missing-command", text: name, path: relative(cwd, path) });
				}
			}
		}
	}
	return findings;
}
