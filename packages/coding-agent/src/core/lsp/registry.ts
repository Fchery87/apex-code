import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface LspLanguageSettings {
	readonly languageId: string;
	readonly extensions?: readonly string[];
	readonly filenames?: readonly string[];
}

export interface LspServerSettings {
	readonly enabled?: boolean;
	readonly command: string;
	readonly args?: readonly string[];
	readonly languages: readonly LspLanguageSettings[];
	readonly rootMarkers?: readonly string[];
	readonly initializationTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
	readonly diagnosticsTimeoutMs?: number;
}

export type LspSettings = Readonly<Record<string, LspServerSettings>>;

export interface ResolvedLspLanguage {
	readonly languageId: string;
	readonly extensions: readonly string[];
	readonly filenames: readonly string[];
}

export interface ResolvedLspServer {
	readonly id: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly languages: readonly ResolvedLspLanguage[];
	readonly rootMarkers: readonly string[];
	readonly initializationTimeoutMs: number;
	readonly requestTimeoutMs: number;
	readonly diagnosticsTimeoutMs: number;
}

export interface ResolvedLspRegistry {
	readonly workspace: string;
	readonly servers: readonly ResolvedLspServer[];
	readonly platform: NodeJS.Platform;
}

export interface SelectedLspServer {
	readonly server: ResolvedLspServer;
	readonly languageId: string;
	readonly path: string;
	readonly root: string;
}

const SERVER_KEYS = new Set([
	"enabled",
	"command",
	"args",
	"languages",
	"rootMarkers",
	"initializationTimeoutMs",
	"requestTimeoutMs",
	"diagnosticsTimeoutMs",
]);
const LANGUAGE_KEYS = new Set(["languageId", "extensions", "filenames"]);

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function compareKey(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? value.toLowerCase() : value;
}

function isContained(workspace: string, candidate: string, platform: NodeJS.Platform): boolean {
	const rel = relative(compareKey(workspace, platform), compareKey(candidate, platform));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateStringArray(value: unknown, label: string, options?: { allowEmpty?: boolean }): readonly string[] {
	if (!Array.isArray(value) || (!options?.allowEmpty && value.length === 0)) {
		throw new Error(`${label} must be ${options?.allowEmpty ? "an" : "a non-empty"} array of strings.`);
	}
	if (value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${label} must contain only non-empty strings.`);
	}
	return value;
}

function validateTimeout(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 100 || (value as number) > 120_000) {
		throw new Error(`${label} must be a safe integer from 100 to 120000.`);
	}
	return value as number;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (platform !== "win32") accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (command.length === 0) throw new Error("LSP command must be non-empty.");
	const hasSeparator = command.includes("/") || command.includes("\\");
	if (hasSeparator && !isAbsolute(command)) {
		throw new Error(`LSP command ${JSON.stringify(command)} must be a bare executable name or an absolute path.`);
	}
	if (isAbsolute(command)) {
		const candidate = canonical(command);
		if (!isExecutableFile(candidate, platform)) throw new Error(`LSP executable is not runnable: ${candidate}`);
		return candidate;
	}

	const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
	const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	const commandHasExtension = platform === "win32" && extname(command) !== "";
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		const candidates =
			platform === "win32" && !commandHasExtension
				? extensions.map((extension) => join(directory, `${command}${extension}`))
				: [join(directory, command)];
		for (const candidate of candidates) if (isExecutableFile(candidate, platform)) return canonical(candidate);
	}
	throw new Error(`LSP executable ${JSON.stringify(command)} was not found in PATH: ${pathValue || "<empty>"}`);
}

function validateUnknownKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0)
		throw new Error(`${label} contains unknown key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

export function resolveLspRegistry(
	settings: LspSettings | undefined,
	options: { workspace: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform },
): ResolvedLspRegistry {
	const workspace = canonical(options.workspace);
	if (!statSync(workspace).isDirectory()) throw new Error(`LSP workspace is not a directory: ${workspace}`);
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const servers: ResolvedLspServer[] = [];
	const claimedMatchers = new Map<string, string>();

	for (const [id, raw] of Object.entries(settings ?? {})) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`LSP server ${id} must be an object.`);
		validateUnknownKeys(raw, SERVER_KEYS, `LSP server ${id}`);
		if (raw.enabled === false) continue;
		if (typeof raw.command !== "string") throw new Error(`LSP server ${id}.command must be a string.`);
		const args =
			raw.args === undefined ? [] : validateStringArray(raw.args, `LSP server ${id}.args`, { allowEmpty: true });
		if (!Array.isArray(raw.languages) || raw.languages.length === 0) {
			throw new Error(`LSP server ${id}.languages must be a non-empty array.`);
		}
		const languages = raw.languages.map((language, index): ResolvedLspLanguage => {
			if (!language || typeof language !== "object" || Array.isArray(language)) {
				throw new Error(`LSP server ${id}.languages[${index}] must be an object.`);
			}
			validateUnknownKeys(language, LANGUAGE_KEYS, `LSP server ${id}.languages[${index}]`);
			if (typeof language.languageId !== "string" || language.languageId.length === 0) {
				throw new Error(`LSP server ${id}.languages[${index}].languageId must be non-empty.`);
			}
			const extensions =
				language.extensions === undefined
					? []
					: validateStringArray(language.extensions, `LSP server ${id}.languages[${index}].extensions`, {
							allowEmpty: true,
						});
			const filenames =
				language.filenames === undefined
					? []
					: validateStringArray(language.filenames, `LSP server ${id}.languages[${index}].filenames`, {
							allowEmpty: true,
						});
			if (extensions.length === 0 && filenames.length === 0)
				throw new Error(`LSP language ${language.languageId} has no matchers.`);
			for (const extension of extensions) {
				if (!extension.startsWith("."))
					throw new Error(`LSP extension ${JSON.stringify(extension)} must start with ".".`);
				const key = `extension:${compareKey(extension, platform)}`;
				const owner = claimedMatchers.get(key);
				if (owner) throw new Error(`LSP ambiguous matcher ${extension}: claimed by ${owner} and ${id}.`);
				claimedMatchers.set(key, id);
			}
			for (const filename of filenames) {
				const key = `filename:${compareKey(filename, platform)}`;
				const owner = claimedMatchers.get(key);
				if (owner) throw new Error(`LSP ambiguous matcher ${filename}: claimed by ${owner} and ${id}.`);
				claimedMatchers.set(key, id);
			}
			return { languageId: language.languageId, extensions, filenames };
		});
		const rootMarkers =
			raw.rootMarkers === undefined
				? []
				: validateStringArray(raw.rootMarkers, `LSP server ${id}.rootMarkers`, { allowEmpty: true });
		if (rootMarkers.some((marker) => basename(marker) !== marker))
			throw new Error(`LSP root markers must be basenames.`);
		servers.push({
			id,
			command: resolveExecutable(raw.command, env, platform),
			args,
			languages,
			rootMarkers,
			initializationTimeoutMs: validateTimeout(raw.initializationTimeoutMs, 10_000, `${id}.initializationTimeoutMs`),
			requestTimeoutMs: validateTimeout(raw.requestTimeoutMs, 10_000, `${id}.requestTimeoutMs`),
			diagnosticsTimeoutMs: validateTimeout(raw.diagnosticsTimeoutMs, 2_000, `${id}.diagnosticsTimeoutMs`),
		});
	}
	return { workspace, servers, platform };
}

function matchLanguage(
	registry: ResolvedLspRegistry,
	path: string,
): { server: ResolvedLspServer; languageId: string } | undefined {
	const filename = compareKey(basename(path), registry.platform);
	const exact: Array<{ server: ResolvedLspServer; languageId: string }> = [];
	const suffixes: Array<{ server: ResolvedLspServer; languageId: string; length: number }> = [];
	for (const server of registry.servers) {
		for (const language of server.languages) {
			if (language.filenames.some((candidate) => compareKey(candidate, registry.platform) === filename)) {
				exact.push({ server, languageId: language.languageId });
			}
			for (const extension of language.extensions) {
				const normalized = compareKey(extension, registry.platform);
				if (filename.endsWith(normalized))
					suffixes.push({ server, languageId: language.languageId, length: normalized.length });
			}
		}
	}
	if (exact.length > 1) throw new Error(`LSP path has ambiguous exact filename matches: ${path}`);
	if (exact[0]) return exact[0];
	const max = suffixes.reduce((value, match) => Math.max(value, match.length), -1);
	const longest = suffixes.filter((match) => match.length === max);
	if (longest.length > 1) throw new Error(`LSP path has ambiguous extension matches: ${path}`);
	return longest[0];
}

export function selectLspServerForPath(
	registry: ResolvedLspRegistry,
	inputPath: string,
): SelectedLspServer | undefined {
	if (!existsSync(inputPath) || !statSync(inputPath).isFile())
		throw new Error(`LSP path is not an existing file: ${inputPath}`);
	const path = canonical(inputPath);
	if (!isContained(registry.workspace, path, registry.platform))
		throw new Error(`Path is outside the LSP workspace: ${path}`);
	const match = matchLanguage(registry, path);
	if (!match) return undefined;
	let root = dirname(path);
	while (true) {
		if (match.server.rootMarkers.some((marker) => existsSync(join(root, marker)))) break;
		if (compareKey(root, registry.platform) === compareKey(registry.workspace, registry.platform)) break;
		const parent = dirname(root);
		if (parent === root || !isContained(registry.workspace, parent, registry.platform)) {
			root = registry.workspace;
			break;
		}
		root = parent;
	}
	return { server: match.server, languageId: match.languageId, path, root: canonical(root) };
}
