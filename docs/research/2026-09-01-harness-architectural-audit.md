# Apex Code Harness Architectural Audit

**Date:** 2026-08-31  
**Target:** Apex Code (`apex-code`), forked from Pi  
**Status:** Complete  

---

## 1. Executive Verdict & Readiness Score

### Readiness Score: 84 / 100

Apex Code is a well-engineered fork of the Pi harness. The codebase demonstrates high architecture discipline in its context engineering pipeline (deferred schemas and tool-result eviction in `packages/coding-agent/src/core/context/`), native Model Context Protocol support (`packages/coding-agent/src/core/mcp/`), permission rule evaluation with OS-level sandboxing (`packages/coding-agent/src/core/sandbox/`), and git-backed session checkpoints (`packages/coding-agent/src/core/checkpoints/git-checkpoints.ts`).

The harness suffers from four primary bottlenecks that prevent fully reliable autonomous execution:
1. **Blind edit failure loops.** When an exact or basic fuzzy string match fails in `edit-diff.ts`, the tool throws a generic error without line numbers, nearest-match suggestions, or diff context. The agent receives zero feedback on why the match failed.
2. **Missing cycle termination guards.** The core execution loop in `packages/agent/src/agent-loop.ts` lacks a maximum recursion depth or turn limit. Runaway tool loops will continue until context compaction triggers or the token budget is exhausted.
3. **Silent test execution.** The built-in `test` tool (`packages/coding-agent/src/core/tools/test.ts`) discards stdout and stderr streams. It returns only an exit code, depriving the model of compiler errors, assertion traces, and test output needed for self-correction.
4. **System prompt bloat.** `packages/coding-agent/src/core/system-prompt.ts` unconditionally injects internal Apex Code documentation paths and file lists into every session prompt, even when the agent operates in an unrelated user repository.

---

## 2. Critical Vulnerabilities & Architectural Flaws (P0 / P1)

### P0: Infinite Tool Execution Loop Risk (Missing ReAct Turn/Depth Limit)
- **File:** `packages/agent/src/agent-loop.ts:172-272`
- **Mechanism:** `runLoop` runs an outer `while (true)` loop and an inner `while (hasMoreToolCalls || pendingMessages.length > 0)` loop. While `shouldStopAfterTurn` can be injected externally (used by mid-run compaction in `agent-session.ts:717`), there is no default maximum turn counter or cycle limit in `agent-loop.ts`.
- **Impact:** If a model hallucinates invalid tool arguments or repeatedly fails an edit, the harness executes indefinite provider calls until the context window overflows or the user manually interrupts.
- **Maintainer Impact:** Adds unmetered API cost and risks runaway sessions in non-interactive batch or RPC execution modes.

### P0: Zero Diagnostic Feedback on Edit Failures
- **File:** `packages/coding-agent/src/core/tools/edit-diff.ts:253-274`
- **Mechanism:** When `fuzzyFindText` cannot locate `oldText`, `getNotFoundError` generates:
  `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`
  When multiple matches occur, `getDuplicateError` outputs:
  `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique.`
- **Impact:** The tool does not return line numbers where duplicate occurrences were found. On a missing match, it does not provide the closest matching lines or candidate line numbers in the file. The LLM is forced to guess alternative context strings blindly or perform redundant `read` calls.

### P1: Blind Test Runner Tool Discards Diagnostic Output
- **File:** `packages/coding-agent/src/core/tools/test.ts:41-42, 88-96`
- **Mechanism:** Lines 41-42 execute:
  ```ts
  child.stdout?.resume();
  child.stderr?.resume();
  ```
  The process output drains into null streams. Line 93 returns:
  `Test runner failed (exit code 1): npm test`
- **Impact:** The agent receives no test failure traces, compiler errors, or assertion messages. This breaks the closed-loop TDD verification cycle.

### P1: Hardcoded Internal Documentation Injection in System Prompt
- **File:** `packages/coding-agent/src/core/system-prompt.ts:117-124`
- **Mechanism:** `buildSystemPrompt` appends 8 lines of static Apex documentation paths and markdown file cross-references (`docs/extensions.md`, `docs/themes.md`, `docs/skills.md`, `docs/tui.md`, `docs/sdk.md`, etc.) to every default system prompt.
- **Impact:** Wastes prompt tokens and primes models with irrelevant internal harness documentation during normal user workspace tasks.

---

## 3. Quality of Life & Workflow Enhancements (P2 / P3)

### P2: Tail-Only Output Truncation in Bash Execution
- **File:** `packages/coding-agent/src/core/tools/truncate.ts:168-241`
- **Mechanism:** `truncateTail` retains only the last N lines or 50KB.
- **Enhancement:** Large build dumps or compiler invocations place the command invocation and early failure headers at the top, and the summary at the bottom. Implement dual head-tail slicing (for example, first 50 lines + truncation marker + last 150 lines) so the agent sees both the command setup and the terminal error summary.

### P2: Context Hierarchy Rules Extension
- **File:** `packages/coding-agent/src/core/resource-loader.ts:71-90`
- **Mechanism:** `loadContextFileFromDir` checks only `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, and uppercase variants.
- **Enhancement:** Add support for modular rule discovery across `.apex/rules/`, `.cursor/rules/*.md`, and `.github/copilot-instructions.md` with deterministic lexical merging.

### P3: Standalone Pre-Completion Linter / Compiler Verification Hook
- **File:** `packages/coding-agent/src/core/agent-session-services.ts:347-355`
- **Mechanism:** Post-mutation diagnostics (`DiagnosticsOperations`) run only when an LSP server is actively configured in `settings.json`.
- **Enhancement:** Provide an optional lightweight pre-completion shell validator hook (e.g., auto-running `npx tsc --noEmit` or configured project linter before closing a multi-edit turn) when no LSP server is active.

---

## 4. Concrete Code Refactors

### Refactor 1: Diagnostic-Rich Line-Matching & Actionable Failure Reporting for `edit-diff.ts`

```typescript
// packages/coding-agent/src/core/tools/edit-diff.ts

export interface MatchFailureDiagnostic {
	readonly editIndex: number;
	readonly searchedText: string;
	readonly closestMatch?: {
		readonly startLine: number;
		readonly endLine: number;
		readonly snippet: string;
		readonly similarity: number;
	};
}

/** Compute character-level bigram Dice coefficient for fast fuzzy line matching. */
function calculateSimilarity(a: string, b: string): number {
	const cleanA = a.trim().replace(/\s+/g, " ");
	const cleanB = b.trim().replace(/\s+/g, " ");
	if (cleanA === cleanB) return 1.0;
	if (cleanA.length < 2 || cleanB.length < 2) return 0.0;

	const getBigrams = (str: string) => {
		const bigrams = new Map<string, number>();
		for (let i = 0; i < str.length - 1; i++) {
			const bigram = str.substring(i, i + 2);
			bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
		}
		return bigrams;
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

/** Find closest matching window in content for unmatched oldText. */
export function findClosestCandidate(
	content: string,
	oldText: string,
): { startLine: number; endLine: number; snippet: string; similarity: number } | undefined {
	const contentLines = content.split("\n");
	const targetLines = oldText.split("\n");
	const windowSize = Math.max(1, targetLines.length);

	let bestSimilarity = 0;
	let bestStartLine = -1;
	let bestEndLine = -1;

	for (let i = 0; i <= contentLines.length - windowSize; i++) {
		const windowContent = contentLines.slice(i, i + windowSize).join("\n");
		const similarity = calculateSimilarity(windowContent, oldText);

		if (similarity > bestSimilarity) {
			bestSimilarity = similarity;
			bestStartLine = i + 1;
			bestEndLine = i + windowSize;
		}
	}

	if (bestSimilarity < 0.4 || bestStartLine === -1) {
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

/** Locate 1-based line numbers for all occurrences of a search text. */
export function findOccurrenceLineNumbers(content: string, oldText: string): number[] {
	const normalizedContent = normalizeForFuzzyMatch(content);
	const normalizedOldText = normalizeForFuzzyMatch(oldText);
	const lineNumbers: number[] = [];
	let searchIndex = 0;

	while (searchIndex < normalizedContent.length) {
		const matchIndex = normalizedContent.indexOf(normalizedOldText, searchIndex);
		if (matchIndex === -1) break;
		const lineNumber = normalizedContent.slice(0, matchIndex).split("\n").length;
		lineNumbers.push(lineNumber);
		searchIndex = matchIndex + Math.max(1, normalizedOldText.length);
	}

	return lineNumbers;
}

export function getNotFoundError(path: string, editIndex: number, totalEdits: number, content: string, oldText: string): Error {
	const label = totalEdits === 1 ? `exact text in ${path}` : `edits[${editIndex}] in ${path}`;
	let message = `Could not find ${label}. The oldText must match lines exactly including indentation.`;

	const candidate = findClosestCandidate(content, oldText);
	if (candidate) {
		message += `\n\nClosest match found at lines ${candidate.startLine}-${candidate.endLine} (${Math.round(candidate.similarity * 100)}% match):\n${candidate.snippet}\n\nRe-read the file with the read tool or update oldText to match lines ${candidate.startLine}-${candidate.endLine}.`;
	}

	return new Error(message);
}

export function getDuplicateError(path: string, editIndex: number, totalEdits: number, content: string, oldText: string): Error {
	const lineNumbers = findOccurrenceLineNumbers(content, oldText);
	const occurrences = lineNumbers.length;
	const label = totalEdits === 1 ? `text in ${path}` : `edits[${editIndex}] in ${path}`;
	const lineList = lineNumbers.length > 0 ? ` at lines ${lineNumbers.join(", ")}` : "";

	return new Error(
		`Found ${occurrences} occurrences of ${label}${lineList}. oldText must be unique. Provide more surrounding context lines to disambiguate the replacement.`,
	);
}
```

---

### Refactor 2: Output-Capturing Test Runner Tool in `packages/coding-agent/src/core/tools/test.ts`

```typescript
import { spawn } from "node:child_process";
import type { AgentTool } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import type { ApexToolDefinition, PermissionSpec } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

const testSchema = Type.Object({
	executable: Type.String({ description: "Test runner executable, for example npm, npx, or pytest" }),
	args: Type.Array(Type.String(), {
		description: "Arguments passed directly to the test runner; never a shell command",
	}),
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

export function createTestPermissionSpec(): PermissionSpec<typeof testSchema> {
	return {
		defaultBehavior: "ask",
		matches: (ruleContent, params) => ruleContent === JSON.stringify(params),
		describe: (ruleContent) => `Run test command: ${ruleContent}`,
		ruleForCall: (params) => JSON.stringify(params),
	};
}

export interface TestToolOptions {
	operations?: TestOperations;
}

export function createTestToolDefinition(
	cwd: string,
	options?: TestToolOptions,
): ApexToolDefinition<typeof testSchema, TestRunDetails> {
	const operations = options?.operations ?? defaultOperations;
	return {
		name: "test",
		label: "test",
		description:
			"Run a test executable with direct argv arguments. Captures test output, errors, and exit status for closed-loop verification.",
		parameters: testSchema,
		contract: {
			capabilities: new Set(["exec"]),
			permission: createTestPermissionSpec(),
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

export function createTestTool(cwd: string, options?: TestToolOptions): AgentTool<typeof testSchema, TestRunDetails> {
	return wrapToolDefinition(createTestToolDefinition(cwd, options));
}
```

---

### Refactor 3: Runaway Loop Guard with Turn & Depth Budgeting in `packages/agent/src/agent-loop.ts`

```typescript
// packages/agent/src/agent-loop.ts (snippet around runLoop)

export const DEFAULT_MAX_TURNS_PER_RUN = 50;

async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let lastCompletedTurn: PrepareNextTurnContext | undefined;
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
	let turnCount = 0;
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS_PER_RUN;

	while (true) {
		let hasMoreToolCalls = true;

		while (hasMoreToolCalls || pendingMessages.length > 0) {
			turnCount++;
			if (turnCount > maxTurns) {
				const limitMessage = `Agent execution halted: reached maximum turn limit (${maxTurns}). Stop runaway loop.`;
				await emit({
					type: "message_start",
					message: { role: "assistant", content: [{ type: "text", text: limitMessage }] },
				});
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			if (lastCompletedTurn) {
				const nextTurnSnapshot = await config.prepareNextTurn?.(lastCompletedTurn);
				if (nextTurnSnapshot) {
					currentContext = nextTurnSnapshot.context ?? currentContext;
					config = {
						...config,
						model: nextTurnSnapshot.model ?? config.model,
						reasoning:
							nextTurnSnapshot.thinkingLevel === undefined
								? config.reasoning
								: nextTurnSnapshot.thinkingLevel === "off"
									? undefined
									: nextTurnSnapshot.thinkingLevel,
					};
				}
				if (pendingMessages.length === 0) {
					pendingMessages = (await config.getSteeringMessages?.()) || [];
				}
				await emit({ type: "turn_start" });
			}

			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;

			if (toolCalls.length > 0) {
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			lastCompletedTurn = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
				hasMoreToolCalls,
			};

			if (await config.shouldStopAfterTurn?.(lastCompletedTurn)) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			pendingMessages = followUpMessages;
			continue;
		}

		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}
```

---

## 5. Audit Matrix Summary

| Criterion | Evaluation Status | File Reference | Core Finding |
| :--- | :--- | :--- | :--- |
| **Prompt Bloat** | **Deficient** | `packages/coding-agent/src/core/system-prompt.ts:117` | Injects static harness documentation paths unconditionally. |
| **Context Hierarchy** | **Pass** | `packages/coding-agent/src/core/resource-loader.ts:119` | Respects ancestor directory traversal and worktree shadowing. |
| **Edit Pipeline** | **Deficient** | `packages/coding-agent/src/core/tools/edit-diff.ts:253` | Fails with zero diagnostic feedback on unmatched text or duplicate collisions. |
| **Bash & Sandboxing** | **Pass** | `packages/coding-agent/src/core/tools/bash.ts:155` | Robust cross-platform process trees, signal handling, and sandbox escalation. |
| **Read & Discovery** | **Pass** | `packages/coding-agent/src/core/tools/read.ts:220` | Paged offsets, continuation hints, and ripgrep streaming. |
| **Loop Mechanics** | **Deficient** | `packages/agent/src/agent-loop.ts:172` | Lacks default max-turn limits in core agent loop. |
| **Steering / Queue** | **Pass** | `packages/coding-agent/src/core/agent-session.ts:1627` | Implements distinct steering (immediate) and follow-up (delayed) queues. |
| **TDD / Self-Correction**| **Deficient** | `packages/coding-agent/src/core/tools/test.ts:41` | Test runner tool drains stdout/stderr, hiding test failure logs from agent. |
| **Session Checkpoints** | **Pass** | `packages/coding-agent/src/core/checkpoints/git-checkpoints.ts:113` | Clean git ref and private index architecture. |
| **MCP Support** | **Pass** | `packages/coding-agent/src/core/mcp/config.ts:1` | Standard `.mcp.json` loading, idle timeouts, and stdio/http transports. |
