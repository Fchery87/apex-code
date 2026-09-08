import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const PI_BUN_BINARY: boolean;
const isBunBinary = typeof PI_BUN_BINARY !== "undefined" && PI_BUN_BINARY;

/** True when Apex is running from TypeScript source rather than a build or a binary. */
export const isTypeScriptSourceRuntime = !isBunBinary && extname(fileURLToPath(import.meta.url)) === ".ts";

function findUp(from: string, name: string): string | undefined {
	let directory = from;
	for (;;) {
		const candidate = join(directory, name);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function extendsTarget(configPath: string): string | undefined {
	try {
		const reference = /"extends"\s*:\s*"([^"]+)"/.exec(readFileSync(configPath, "utf8"))?.[1];
		if (!reference) return undefined;
		return isAbsolute(reference) ? reference : resolve(dirname(configPath), reference);
	} catch {
		return undefined;
	}
}

/**
 * The tsconfig chain the extension loader reads when it compiles an extension
 * from TypeScript source.
 *
 * A sandboxed child cannot read what the profile does not grant, and the macOS
 * profile denies the whole home directory before re-allowing named paths. Without
 * these, loading a `.ts` extension inside the sandbox fails on the config rather
 * than on anything the extension does. Empty for a built or binary runtime, which
 * resolves through aliases and never opens a tsconfig.
 */
export function typeScriptSourceConfigFiles(): readonly string[] {
	if (!isTypeScriptSourceRuntime) return [];
	const root = findUp(dirname(fileURLToPath(import.meta.url)), "tsconfig.json");
	if (!root) return [];

	const chain: string[] = [];
	const seen = new Set<string>();
	let current: string | undefined = root;
	while (current && !seen.has(current) && existsSync(current)) {
		seen.add(current);
		chain.push(current);
		current = extendsTarget(current);
	}
	return chain;
}
