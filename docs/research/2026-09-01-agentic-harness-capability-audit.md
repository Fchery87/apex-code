# Agentic Harness Capability and Correctness Audit

**Date:** 2026-08-31  
**Target:** Apex Code (`apex-code`), forked from Pi  
**Status:** Complete  

---

## Executive Summary

This report provides an architectural and code-level audit of the `apex-code` repository. The evaluation spans seven core pillars of modern AI agent harnesses:
1. Context Hierarchy and KV-Cache Stability
2. Tool Engine and Diff Reliability
3. Protocol and Language Server Integrations
4. Interactive TUI and Stream Steering
5. Session Persistence and DAG Tree History
6. Deterministic Verification Gates and Hooks
7. Multi-Mode Execution Runtimes

---

## Section A: Implementation Scorecard

| Pillar | Feature | Status | File Path / Location |
| :--- | :--- | :--- | :--- |
| **1. Context & Cache** | Static Prefix Order | ⚠️ Partial | `packages/coding-agent/src/core/system-prompt.ts:42-146` |
| **1. Context & Cache** | Progressive Skill Disclosure | ✅ Implemented | `packages/coding-agent/src/core/skills.ts:400-445`, `packages/coding-agent/src/core/tools/skill-search.ts:39-81` |
| **1. Context & Cache** | Code-Aware Compaction | ⚠️ Partial | `packages/coding-agent/src/core/compaction/compaction.ts:40-70`, `packages/coding-agent/src/core/compaction/utils.ts:27-82` |
| **2. Tool Engine** | `edit` Resilience & Diagnostics | ⚠️ Partial | `packages/coding-agent/src/core/tools/edit-diff.ts:207-274` |
| **2. Tool Engine** | Bash Output Slicing (Head/Tail) | ⚠️ Partial | `packages/coding-agent/src/core/tools/truncate.ts:168-241`, `packages/coding-agent/src/core/tools/bash.ts:515-533` |
| **2. Tool Engine** | Process Lifecycle & Signal Tree | ✅ Implemented | `packages/coding-agent/src/core/tools/bash.ts:155-224`, `packages/coding-agent/src/utils/shell.ts:14-18` |
| **3. Protocols & LSP** | Model Context Protocol (MCP) | ✅ Implemented | `packages/coding-agent/src/core/mcp/config.ts:1-171`, `packages/coding-agent/src/core/mcp/server-manager.ts:1-140` |
| **3. Protocols & LSP** | AST & Symbol Primitives | ⚠️ Partial | `packages/coding-agent/src/core/tools/lsp.ts:13-284` |
| **4. Interactive TUI** | Differential Screen Buffer | ✅ Implemented | `packages/tui/src/tui-main-screen.ts:123-260` |
| **4. Interactive TUI** | Input Queue Separation | ✅ Implemented | `packages/coding-agent/src/core/agent-session.ts:1627-1645`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4336-4358` |
| **4. Interactive TUI** | TUI Folding (`Ctrl+T`, `Ctrl+O`) | ✅ Implemented | `packages/coding-agent/src/core/keybindings.ts:112-116` |
| **5. Persistence & DAG** | Tree-Structured History (DAG) | ✅ Implemented | `packages/coding-agent/src/core/session-manager.ts:53-129` |
| **5. Persistence & DAG** | Branch Navigation & Rollback | ⚠️ Partial | `packages/coding-agent/src/core/agent-session.ts:3416-3600`, `packages/coding-agent/src/core/checkpoints/git-checkpoints.ts:113-275` |
| **6. Verification** | Pre-Completion Verification Gates | ❌ Missing | `packages/coding-agent/src/core/agent-session.ts:1600-1750` |
| **6. Verification** | Error Feedback Loop | ⚠️ Partial | `packages/coding-agent/src/core/tools/test.ts:41-44`, `packages/coding-agent/src/core/tools/diagnostics.ts:88-109` |
| **6. Verification** | Post-Edit Formatters | ❌ Missing | `packages/coding-agent/src/core/tools/edit.ts:107-120`, `packages/coding-agent/src/core/tools/write.ts:100-115` |
| **7. Multi-Mode Runtimes** | Interactive TUI | ✅ Implemented | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:994-1026` |
| **7. Multi-Mode Runtimes** | Print / Pipe Mode (`-p`) | ✅ Implemented | `packages/coding-agent/src/cli/args.ts:200-206`, `packages/coding-agent/src/modes/print-mode.ts:33-150` |
| **7. Multi-Mode Runtimes** | Structured Stream (`--mode json`) | ✅ Implemented | `packages/coding-agent/src/modes/json-event.ts:1-75`, `packages/coding-agent/src/modes/print-mode.ts:27-32` |
| **7. Multi-Mode Runtimes** | RPC Protocol (`--mode rpc`) | ✅ Implemented | `packages/coding-agent/src/modes/rpc/rpc-mode.ts:1-550`, `packages/coding-agent/src/modes/rpc/rpc-client.ts:1-400` |

---

## Section B: Deep-Dive Code Correctness & Anti-Patterns

### 1. `edit` Tool Resilience and Diagnostic Failure Reporting
- **File and Lines:** `packages/coding-agent/src/core/tools/edit-diff.ts:207-274`
- **Architectural Flaw:** `fuzzyFindText` applies normalization only for trailing whitespace and unicode quotes or dashes. If indentation differs by even one space or tab, matching returns `found: false`. When the match fails, `getNotFoundError` returns a generic error string without line numbers or candidate snippets. When duplicates occur, `getDuplicateError` does not tell the model where the collisions were detected.
- **Runtime Failure Mode:** Models enter repetitive blind retry loops. They guess context strings without knowing why the match failed, or they execute redundant `read` operations to re-inspect lines they already touched.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/tools/edit-diff.ts

export interface MatchFailureCandidate {
	readonly startLine: number;
	readonly endLine: number;
	readonly snippet: string;
	readonly similarity: number;
}

function calculateDiceCoefficient(a: string, b: string): number {
	const cleanA = a.trim().replace(/\s+/g, " ");
	const cleanB = b.trim().replace(/\s+/g, " ");
	if (cleanA === cleanB) return 1.0;
	if (cleanA.length < 2 || cleanB.length < 2) return 0.0;

	const getBigrams = (str: string) => {
		const map = new Map<string, number>();
		for (let i = 0; i < str.length - 1; i++) {
			const bigram = str.substring(i, i + 2);
			map.set(bigram, (map.get(bigram) ?? 0) + 1);
		}
		return map;
	};

	const bigramsA = getBigrams(cleanA);
	const bigramsB = getBigrams(cleanB);
	let intersection = 0;

	for (const [bigram, countA] of bigramsA.entries()) {
		const countB = bigramsB.get(bigram) ?? 0;
		intersection += Math.min(countA, countB);
	}

	return (2.0 * intersection) / (cleanA.length - 1 + cleanB.length - 1);
}

export function findClosestCandidate(content: string, oldText: string): MatchFailureCandidate | undefined {
	const contentLines = content.split("\n");
	const targetLines = oldText.split("\n");
	const windowSize = Math.max(1, targetLines.length);

	let bestSimilarity = 0;
	let bestStartLine = -1;
	let bestEndLine = -1;

	for (let i = 0; i <= contentLines.length - windowSize; i++) {
		const window = contentLines.slice(i, i + windowSize).join("\n");
		const similarity = calculateDiceCoefficient(window, oldText);

		if (similarity > bestSimilarity) {
			bestSimilarity = similarity;
			bestStartLine = i + 1;
			bestEndLine = i + windowSize;
		}
	}

	if (bestSimilarity < 0.35 || bestStartLine === -1) {
		return undefined;
	}

	const snippet = contentLines
		.slice(bestStartLine - 1, bestEndLine)
		.map((line, idx) => `  ${bestStartLine + idx}: ${line}`)
		.join("\n");

	return {
		startLine: bestStartLine,
		endLine: bestEndLine,
		snippet,
		similarity: Number(bestSimilarity.toFixed(2)),
	};
}

export function findOccurrenceLineNumbers(content: string, oldText: string): number[] {
	const normalizedContent = normalizeForFuzzyMatch(content);
	const normalizedOldText = normalizeForFuzzyMatch(oldText);
	const lines: number[] = [];
	let searchIndex = 0;

	while (searchIndex < normalizedContent.length) {
		const matchIndex = normalizedContent.indexOf(normalizedOldText, searchIndex);
		if (matchIndex === -1) break;
		const lineNumber = normalizedContent.slice(0, matchIndex).split("\n").length;
		lines.push(lineNumber);
		searchIndex = matchIndex + Math.max(1, normalizedOldText.length);
	}

	return lines;
}

export function getNotFoundError(path: string, editIndex: number, totalEdits: number, content: string, oldText: string): Error {
	const label = totalEdits === 1 ? `exact text in ${path}` : `edits[${editIndex}] in ${path}`;
	let message = `Could not find ${label}. The oldText must match exact lines and indentation.`;

	const candidate = findClosestCandidate(content, oldText);
	if (candidate) {
		message += `\n\nClosest match found at lines ${candidate.startLine}-${candidate.endLine} (${Math.round(candidate.similarity * 100)}% match):\n${candidate.snippet}\n\nUpdate oldText to match lines ${candidate.startLine}-${candidate.endLine}.`;
	}

	return new Error(message);
}

export function getDuplicateError(path: string, editIndex: number, totalEdits: number, content: string, oldText: string): Error {
	const lines = findOccurrenceLineNumbers(content, oldText);
	const count = lines.length;
	const label = totalEdits === 1 ? `text in ${path}` : `edits[${editIndex}] in ${path}`;
	const locationList = lines.length > 0 ? ` at lines ${lines.join(", ")}` : "";

	return new Error(`Found ${count} occurrences of ${label}${locationList}. oldText must be unique.`);
}
```

---

### 2. Silent Test Execution in Built-in Test Tool
- **File and Lines:** `packages/coding-agent/src/core/tools/test.ts:41-44`, `packages/coding-agent/src/core/tools/test.ts:88-96`
- **Architectural Flaw:** `defaultOperations.run` executes `child.stdout?.resume()` and `child.stderr?.resume()`, discarding standard output and standard error streams. `execute()` returns only a one-line status string `Test runner failed (exit code 1): ...`.
- **Runtime Failure Mode:** Models cannot perform test-driven self-correction. The agent sees an exit code without stack traces, failed assertion lines, or compilation errors.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/tools/test.ts

import { spawn } from "node:child_process";
import type { AgentTool } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import type { ApexToolDefinition, PermissionSpec } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

const testSchema = Type.Object({
	executable: Type.String({ description: "Test runner executable (e.g. npm, npx, pytest, cargo)" }),
	args: Type.Array(Type.String(), { description: "Direct argv arguments" }),
});

export type TestToolInput = Static<typeof testSchema>;

export interface TestRunDetails {
	cwd: string;
	executable: string;
	argv: string[];
	exitCode: number | null;
	truncated?: boolean;
}

export interface TestOperationResult {
	exitCode: number | null;
	output: string;
	truncated: boolean;
}

export interface TestOperations {
	run(input: { executable: string; argv: string[]; cwd: string; signal?: AbortSignal }): Promise<TestOperationResult>;
}

const defaultOperations: TestOperations = {
	async run({ executable, argv, cwd, signal }) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const child = spawn(executable, argv, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf-8");
		});

		const abort = () => child.kill();
		if (signal) signal.addEventListener("abort", abort, { once: true });

		try {
			const exitCode = await waitForChildProcess(child);
			const truncated = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			return {
				exitCode,
				output: truncated.content,
				truncated: truncated.truncated,
			};
		} finally {
			if (signal) signal.removeEventListener("abort", abort);
		}
	},
};

export function createTestToolDefinition(cwd: string, options?: { operations?: TestOperations }): ApexToolDefinition<typeof testSchema, TestRunDetails> {
	const operations = options?.operations ?? defaultOperations;
	return {
		name: "test",
		label: "test",
		description: "Run tests with argv arguments and capture execution logs, failure traces, and exit codes.",
		parameters: testSchema,
		contract: {
			capabilities: new Set(["exec"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent, params) => ruleContent === JSON.stringify(params),
				describe: (ruleContent) => `Run test command: ${ruleContent}`,
				ruleForCall: (params) => JSON.stringify(params),
			},
			context: { resultRecoverable: false, deferSchema: false },
			evidence: {
				emits: new Set(["test"]),
				capture: (_params, result) => [{ kind: "test", ...result.details }],
			},
		},
		async execute(_toolCallId, input, signal) {
			const observed = await operations.run({ executable: input.executable, argv: input.args, cwd, signal });
			const details: TestRunDetails = {
				cwd,
				executable: input.executable,
				argv: [...input.args],
				exitCode: observed.exitCode,
				truncated: observed.truncated,
			};

			const status = details.exitCode === 0 ? "passed" : `failed (exit code ${details.exitCode ?? "unknown"})`;
			let resultText = `Test runner ${status}: ${input.executable} ${input.args.join(" ")}`;

			if (observed.output.trim().length > 0) {
				resultText += `\n\n--- Output ---\n${observed.output.trim()}`;
			}

			if (observed.truncated) {
				resultText += `\n\n[Output truncated to last ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},
	};
}

export function createTestTool(cwd: string, options?: { operations?: TestOperations }): AgentTool<typeof testSchema, TestRunDetails> {
	return wrapToolDefinition(createTestToolDefinition(cwd, options));
}
```

---

### 3. Tail-Only Shell Truncation
- **File and Lines:** `packages/coding-agent/src/core/tools/truncate.ts:168-241`, `packages/coding-agent/src/core/tools/bash.ts:515-533`
- **Architectural Flaw:** `truncateTail` retains only the trailing N lines or 50KB.
- **Runtime Failure Mode:** Compilers and test frameworks print the primary error and command invocation at the start, and summarize tallies at the bottom. Discarding the head strips the initial failure cause and leaves only downstream cascade errors.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/tools/truncate.ts

export interface DualTruncationOptions extends TruncationOptions {
	readonly headLines?: number;
	readonly tailLines?: number;
}

export function truncateHeadTail(content: string, options: DualTruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const headLimit = options.headLines ?? 50;
	const tailLimit = options.tailLines ?? 150;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	const totalLines = lines.length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const head = lines.slice(0, headLimit);
	const tail = lines.slice(-tailLimit);
	const skippedCount = totalLines - head.length - tail.length;

	const separator = `\n\n[... ${skippedCount} lines omitted for context conservation ...]\n\n`;
	const combined = `${head.join("\n")}${separator}${tail.join("\n")}`;

	return {
		content: combined,
		truncated: true,
		truncatedBy: "lines",
		totalLines,
		totalBytes,
		outputLines: head.length + tail.length,
		outputBytes: Buffer.byteLength(combined, "utf-8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}
```

---

### 4. Compaction Working-Tree Diff Loss
- **File and Lines:** `packages/coding-agent/src/core/compaction/compaction.ts:40-70`, `packages/coding-agent/src/core/compaction/utils.ts:27-82`
- **Architectural Flaw:** Compaction tracks read and modified file paths via `<read-files>` and `<modified-files>`, but does not inspect working tree changes or capture active uncommitted diffs.
- **Runtime Failure Mode:** When context compactions occur mid-refactor, the agent receives high-level summaries but loses track of intermediate unstaged diffs. This results in models rewriting files from scratch or introducing regression breaks.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/compaction/diff-capture.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function captureWorkingTreeDiff(cwd: string, maxBytes = 20 * 1024): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["diff", "--no-color", "--stat", "-p"], {
			cwd,
			timeout: 5000,
			maxBuffer: maxBytes * 2,
		});

		const trimmed = stdout.trim();
		if (!trimmed) return "";
		if (Buffer.byteLength(trimmed, "utf-8") <= maxBytes) {
			return `<active-git-diff>\n${trimmed}\n</active-git-diff>`;
		}

		return `<active-git-diff>\n${trimmed.slice(0, maxBytes)}\n\n[... diff truncated for token limit ...]\n</active-git-diff>`;
	} catch {
		return "";
	}
}
```

---

### 5. Static Prefix System Prompt Pollution
- **File and Lines:** `packages/coding-agent/src/core/system-prompt.ts:117-124`
- **Architectural Flaw:** `buildSystemPrompt` unconditionally injects 8 lines of static Apex documentation paths and markdown cross-references into every session system prompt, even when the agent works in user projects.
- **Runtime Failure Mode:** Injects unnecessary tokens into the static prefix and confuses models by advertising internal documentation files that do not exist in the target repository.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/system-prompt.ts (selective documentation injection)

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

	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList = visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n");
	const contributedGuidelines = dedupeGuidelines(promptGuidelines ?? []);

	let prompt: string;

	if (customPrompt) {
		prompt = customPrompt;
		if (toolsList.length > 0) prompt += `\n\nAvailable tools:\n${toolsList}`;
		if (contributedGuidelines.length > 0) {
			prompt += `\n\nGuidelines:\n${contributedGuidelines.map((g) => `- ${g}`).join("\n")}`;
		}
	} else {
		const guidelines = dedupeGuidelines([
			...contributedGuidelines,
			"Be concise in your responses",
			"Show file paths clearly when working with files",
		])
			.map((g) => `- ${g}`)
			.join("\n");

		prompt = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n${toolsList.length > 0 ? toolsList : "(none)"}\n\nGuidelines:\n${guidelines}`;
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
```

---

### 6. Missing Workspace-Wide Symbol Search in LSP Tool
- **File and Lines:** `packages/coding-agent/src/core/tools/lsp.ts:13-284`
- **Architectural Flaw:** The `lsp` tool supports only `document_symbols` on single files, `definition`, and `references`. It lacks `workspace/symbol` queries.
- **Runtime Failure Mode:** The agent cannot discover symbol locations across large monorepos without performing slow text greps.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/tools/lsp.ts (workspace_symbols operation addition)

const lspWorkspaceSymbolsSchema = Type.Object({
	operation: Type.Literal("workspace_symbols", { description: "Search symbols across the entire workspace." }),
	query: Type.String({ description: "Symbol name or substring to search for." }),
});

const lspSchema = Type.Union([lspNavigationSchema, lspDocumentSymbolsSchema, lspWorkspaceSymbolsSchema]);

// In createLspToolDefinition.execute:
if (input.operation === "workspace_symbols") {
	const raw = await operations.request(
		resolveToCwd(".", cwd),
		"workspace/symbol",
		{ query: input.query },
		signal,
	);
	const { symbols, omitted } = flattenSymbols(raw, "workspace");
	const { symbols: capped, truncated } = capSymbols(symbols, MAX_SYMBOLS);
	return {
		content: [{ type: "text", text: formatSymbolsText(capped, omitted, truncated) }],
		details: { operation: "workspace_symbols", symbols: capped, omitted, truncated },
	};
}
```

---

### 7. Decoupled Checkpoint Restoration on `/tree` Branch Navigation
- **File and Lines:** `packages/coding-agent/src/core/agent-session.ts:3416-3600`, `packages/coding-agent/src/core/checkpoints/session-checkpoints.ts:30-48`
- **Architectural Flaw:** `navigateTree` rewinds the conversational message DAG in `SessionManager`, but never calls `this._checkpoints.engine().restore(checkpoint)`.
- **Runtime Failure Mode:** Conversational context rewinds to an earlier turn, but file edits from the abandoned branch remain on disk. The agent is left with a conversational state that disagrees with actual filesystem contents.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/agent-session.ts (inside navigateTree)

const checkpointEngine = await this._checkpoints.engine();
if (checkpointEngine) {
	const targetCheckpoint = await checkpointEngine.lookup(newLeafId ?? targetId);
	if (targetCheckpoint) {
		await checkpointEngine.restore(targetCheckpoint);
	}
}
```

---

### 8. Missing Pre-Completion Verification Gate
- **File and Lines:** `packages/coding-agent/src/core/agent-session.ts:1600-1750`
- **Architectural Flaw:** The harness has no pre-completion verification hook to run configured linters, test commands, or typechecks before declaring a turn complete.
- **Runtime Failure Mode:** Agents output completion messages with unverified code changes. Syntax errors, broken imports, and broken test assertions are left undetected on disk.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/verification/pre-completion-gate.ts

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface VerificationConfig {
	readonly command?: string;
	readonly timeoutMs?: number;
}

export interface VerificationOutcome {
	readonly passed: boolean;
	readonly command: string;
	readonly output: string;
}

export async function runPreCompletionVerification(
	cwd: string,
	config: VerificationConfig,
	signal?: AbortSignal,
): Promise<VerificationOutcome | undefined> {
	if (!config.command) return undefined;

	try {
		const { stdout, stderr } = await execAsync(config.command, {
			cwd,
			timeout: config.timeoutMs ?? 30000,
			signal,
		});
		return {
			passed: true,
			command: config.command,
			output: `${stdout}\n${stderr}`.trim(),
		};
	} catch (error: any) {
		return {
			passed: false,
			command: config.command,
			output: `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}`.trim(),
		};
	}
}
```

---

### 9. Missing Post-Edit Formatters
- **File and Lines:** `packages/coding-agent/src/core/tools/edit.ts:107-120`, `packages/coding-agent/src/core/tools/write.ts:100-115`
- **Architectural Flaw:** Mutation tools write directly to disk without invoking project formatters (Prettier, Biome, rustfmt, dprint).
- **Runtime Failure Mode:** Files modified by agents suffer from inconsistent indentation, missing semicolons, and lint violations that require separate manual cleanup passes.

#### Production Refactor

```typescript
// packages/coding-agent/src/core/tools/formatters.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runPostEditFormatter(absolutePath: string, cwd: string): Promise<void> {
	try {
		if (absolutePath.endsWith(".ts") || absolutePath.endsWith(".tsx") || absolutePath.endsWith(".js") || absolutePath.endsWith(".json")) {
			await execFileAsync("npx", ["biome", "format", "--write", absolutePath], { cwd, timeout: 5000 });
		}
	} catch {
		// Degrades gracefully when formatter is unconfigured
	}
}
```

---

## Section C: Prioritized Action Plan

### P0 (Critical Runtime & Tool Stability)
- **Fix `test` Tool Output Discarding:** Replace stdout/stderr drain with process buffer capture in `packages/coding-agent/src/core/tools/test.ts:41` to enable closed-loop test-driven self-correction.
- **Implement `edit` Failure Candidates:** Add Bigram Dice similarity matching and duplicate line detection in `packages/coding-agent/src/core/tools/edit-diff.ts:253` to eliminate blind retry loops.
- **Connect Filesystem Rollback to `/tree` Navigation:** Wire `gitCheckpoints.restore()` into `navigateTree` in `packages/coding-agent/src/core/agent-session.ts:3580` to synchronize disk state with conversational history.

### P1 (Context & Cache Optimization)
- **Strip Hardcoded Internal Documentation:** Remove static Apex internal documentation paths from the default system prompt in `packages/coding-agent/src/core/system-prompt.ts:117`.
- **Implement Dual Head/Tail Slicing:** Add `truncateHeadTail` (50 head lines + 150 tail lines) to `packages/coding-agent/src/core/tools/truncate.ts:168` and integrate into `packages/coding-agent/src/core/tools/bash.ts:515`.
- **Preserve Uncommitted Diffs in Compaction:** Capture active `git diff` during `prepareCompaction` in `packages/coding-agent/src/core/compaction/compaction.ts:750`.

### P2 (UX & Extensibility Upgrades)
- **Add Workspace Symbol Support:** Expose `workspace/symbol` in `packages/coding-agent/src/core/tools/lsp.ts:250` for fast workspace symbol discovery.
- **Add Pre-Completion Verification Gate:** Introduce configurable linter/test pre-completion checks before turn completion in `packages/coding-agent/src/core/agent-session.ts:1640`.
- **Add Post-Edit Auto-Formatters:** Attach automatic Biome / Prettier execution to `packages/coding-agent/src/core/tools/edit.ts:115` and `packages/coding-agent/src/core/tools/write.ts:105`.
