import { spawn } from "node:child_process";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	type HookCommandHandlerConfig,
	type HookEventPayload,
	type HookHandler,
	type HookOutcome,
} from "./types.ts";

// A runaway formatter can emit megabytes; the decision that matters is at the
// start, so cap what we retain rather than what the child may write.
const MAX_HOOK_OUTPUT_CHARS = 1_000_000;

function truncate(text: string): string {
	return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/**
 * Shared decision parsing for command stdout and HTTP response bodies.
 * Non-JSON output, a non-object, or an unknown decision value is "no decision"
 * plus a warning -- never an allow (spec, Risks).
 */
export function parseHookDecisionOutput(text: string): HookOutcome {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: true };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: true, warning: `hook output was not valid JSON: ${truncate(trimmed)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: true, warning: `hook output was not a JSON object: ${truncate(trimmed)}` };
	}
	const decision = (parsed as { decision?: unknown }).decision;
	if (decision === undefined) return { ok: true };
	if (decision !== "allow" && decision !== "block" && decision !== "ask") {
		return { ok: true, warning: `hook output had an unknown decision: ${truncate(String(decision))}` };
	}
	const reason = (parsed as { reason?: unknown }).reason;
	return {
		ok: true,
		decision: { decision, ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}) },
	};
}

/**
 * A command handler runs through the platform shell (`sh -c`, PowerShell on
 * Windows) with the event payload on stdin and its decision on stdout.
 *
 * Exit-code table (behavioral reference:
 * docs/research/2026-08-31-harness-landscape.md § 2.1): exit 0 + JSON = that
 * decision; exit 0 + no output = no decision; exit 2 = block with stderr as
 * the reason; any other nonzero exit (and spawn failure, and timeout) is a
 * failure outcome, which the runtime turns into a fail-closed block.
 */
export function commandHookHandler(config: HookCommandHandlerConfig): HookHandler {
	const timeoutMs = config.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
	const commandRef = truncate(config.command);
	return {
		async execute(payload: HookEventPayload): Promise<HookOutcome> {
			const shell = process.platform === "win32" ? "powershell.exe" : "sh";
			const args =
				process.platform === "win32" ? ["-NoProfile", "-Command", config.command] : ["-c", config.command];
			return await new Promise<HookOutcome>((resolve) => {
				const child = spawn(shell, args, { stdio: ["pipe", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				let settled = false;
				const finish = (outcome: HookOutcome) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(outcome);
				};
				const timer = setTimeout(() => {
					child.kill();
					finish({ ok: false, warning: `hook timed out after ${timeoutMs}ms: ${commandRef}` });
				}, timeoutMs);
				child.stdout.on("data", (chunk: Buffer) => {
					if (stdout.length < MAX_HOOK_OUTPUT_CHARS) stdout += chunk.toString("utf8");
				});
				child.stderr.on("data", (chunk: Buffer) => {
					if (stderr.length < MAX_HOOK_OUTPUT_CHARS) stderr += chunk.toString("utf8");
				});
				// A hook that closes stdin early must not crash the write; the exit code decides.
				child.stdin.on("error", () => {});
				child.on("error", (error) => finish({ ok: false, warning: `hook failed to spawn: ${error.message}` }));
				child.on("close", (code) => {
					if (code === 0) {
						finish(parseHookDecisionOutput(stdout));
					} else if (code === 2) {
						finish({
							ok: true,
							decision: {
								decision: "block",
								reason: stderr.trim() || stdout.trim() || "blocked by hook (exit 2)",
							},
						});
					} else if (code === null) {
						finish({ ok: false, warning: `hook terminated by a signal: ${commandRef}` });
					} else {
						finish({
							ok: false,
							warning: `hook exited with exit code ${code}: ${stderr.trim() || stdout.trim() || commandRef}`,
						});
					}
				});
				child.stdin.end(JSON.stringify(payload));
			});
		},
	};
}
