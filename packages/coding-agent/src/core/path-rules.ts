import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { minimatch } from "minimatch";

export interface PathRule {
	path: string;
	globs: string[];
	body: string;
}

function parseRule(filePath: string, text: string): PathRule | undefined {
	if (!text.startsWith("---\n")) return undefined;
	const end = text.indexOf("\n---\n", 4);
	if (end === -1) return undefined;
	const frontmatter = text.slice(4, end);
	const globs = frontmatter
		.split("\n")
		.map((line) => line.match(/^\s+-\s+(.+)$/)?.[1]?.trim())
		.filter((value): value is string => Boolean(value));
	if (globs.length === 0) return undefined;
	return { path: filePath, globs, body: text.slice(end + 5).trim() };
}

/** Rules under `.apex-code/rules/` whose `paths` glob matches `target`. Not loaded at startup. */
export function matchingPathRules(cwd: string, target: string): PathRule[] {
	const dir = join(cwd, ".apex-code", "rules");
	if (!existsSync(dir)) return [];
	const relativeTarget = relative(cwd, join(cwd, target)).split("\\").join("/");
	const rules: PathRule[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".md")) continue;
		const filePath = join(dir, name);
		const rule = parseRule(filePath, readFileSync(filePath, "utf-8"));
		if (!rule) continue;
		if (rule.globs.some((glob) => minimatch(relativeTarget, glob, { dot: true }))) rules.push(rule);
	}
	return rules;
}
