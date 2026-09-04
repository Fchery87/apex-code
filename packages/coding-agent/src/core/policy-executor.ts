/**
 * VF.3: the bounded argv command executor (spec
 * 2026-09-01-configured-verification-and-formatting.md § 2). Runs a
 * `CommandPolicy` from the VF.2 loader verbatim: executable + argv spawn
 * with no shell, under the policy's numeric bounds, with process-tree
 * termination on timeout and cancellation. Outcomes are structured values;
 * a command that merely fails is data, never a throw.
 *
 * Trusting the loader: this module does NOT re-validate policy fields the
 * loader already guarantees (numeric bounds, shell:false, argv shapes). The
 * one defensive re-check is the cwd confinement, because a resolved path is
 * cheap to verify and the worst failure here is running outside the
 * workspace.
 */

import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { killProcessTree, sanitizeBinaryOutput } from "../utils/shell.ts";
import type { CommandPolicy } from "./policy-loader.ts";
import type { WorkspaceArtifactRef, WorkspaceArtifactStore } from "./workspace/artifacts.ts";

export type PolicyRunStatus = "passed" | "failed" | "spawn-failed" | "timeout" | "cancelled" | "refused";

export interface PolicyRunOptions {
	workspaceRoot: string;
	signal?: AbortSignal;
	/** When present, the full combined output is retained under the session's artifact policy. */
	artifactStore?: WorkspaceArtifactStore;
}

export interface PolicyRunOutcome {
	status: PolicyRunStatus;
	policyId: string;
	executable: string;
	argv: string[];
	/** The working directory the command actually ran in (or would have run in). */
	cwd: string;
	durationMs: number;
	exitCode?: number;
	signal?: string;
	/** True when output was captured only partially because a bound was hit. */
	truncated: boolean;
	stdoutBytes: number;
	stderrBytes: number;
	/** Bounded, sanitized text for the model; full bytes go to the artifact store. */
	outputExcerpt: string;
	artifact?: WorkspaceArtifactRef;
	/** Why a command could not run at all ("refused" / "spawn-failed"). */
	refusalReason?: string;
}

/** Hard retention ceiling for artifact bytes, independent of policy caps. */
const MAX_RETENTION_BYTES = 8 * 1024 * 1024;

interface CapturedStream {
	/** Full stream bytes up to the retention ceiling — what the artifact keeps. */
	chunks: Buffer[];
	/** True total bytes seen, even past the retention ceiling. */
	bytes: number;
	/** Last capBytes of the stream — what the excerpt shows. */
	window: Buffer[];
	truncated: boolean;
}

function newStream(): CapturedStream {
	return { chunks: [], bytes: 0, window: [], truncated: false };
}

function capture(stream: CapturedStream, chunk: Buffer, capBytes: number): void {
	stream.bytes += chunk.byteLength;
	if (stream.bytes > capBytes) {
		stream.truncated = true;
	}
	const retentionTotal = stream.chunks.reduce((sum, part) => sum + part.byteLength, 0);
	if (retentionTotal < MAX_RETENTION_BYTES) {
		stream.chunks.push(chunk);
	}
	// Keep the excerpt window bounded to the last capBytes so it shows the
	// most recent output, not the start.
	stream.window.push(chunk);
	const windowTotal = stream.window.reduce((sum, part) => sum + part.byteLength, 0);
	if (windowTotal > capBytes) {
		stream.truncated = true;
		let drop = windowTotal - capBytes;
		while (drop > 0 && stream.window.length > 0) {
			const first = stream.window[0];
			if (first.byteLength <= drop) {
				drop -= first.byteLength;
				stream.window.shift();
			} else {
				stream.window[0] = first.subarray(drop);
				drop = 0;
			}
		}
	}
}

function decode(stream: CapturedStream): string {
	return sanitizeBinaryOutput(Buffer.concat(stream.window).toString("utf-8"));
}

function excerptFor(stdout: CapturedStream, stderr: CapturedStream, policy: CommandPolicy): string {
	const sections: string[] = [];
	const stdoutText = decode(stdout);
	const stderrText = decode(stderr);
	if (stdoutText.length > 0) {
		sections.push(stdoutText);
	}
	if (stderrText.length > 0) {
		sections.push(stderrText);
	}
	const combined = sections.join("\n");
	const lines = combined.split("\n");
	if (lines.length > policy.maxOutputLines) {
		// The notice lives INSIDE the budget: the excerpt never exceeds
		// maxOutputLines lines in total.
		return [
			...lines.slice(0, policy.maxOutputLines - 1),
			`<${lines.length - policy.maxOutputLines + 1} more lines truncated>`,
		].join("\n");
	}
	return combined;
}

export async function runPolicyCommand(command: CommandPolicy, options: PolicyRunOptions): Promise<PolicyRunOutcome> {
	const started = Date.now();
	const base = {
		policyId: command.id,
		executable: command.executable,
		argv: command.argv,
	};

	if (options.signal?.aborted) {
		return {
			...base,
			argv: base.argv,
			cwd: options.workspaceRoot,
			durationMs: 0,
			status: "cancelled",
			truncated: false,
			stdoutBytes: 0,
			stderrBytes: 0,
			outputExcerpt: "",
			refusalReason: "cancelled before the command started",
		};
	}

	// Defense in depth against a cwd escaping the workspace. The loader
	// already rejects absolute paths and ".." segments; resolve() here is the
	// second gate, on the computed path rather than the configured string.
	const cwd = command.cwd === "workspace" ? options.workspaceRoot : resolve(options.workspaceRoot, command.cwd);
	const containmentRoot = resolve(options.workspaceRoot);
	if (cwd !== containmentRoot && !cwd.startsWith(containmentRoot + (isAbsolute(containmentRoot) ? "/" : ""))) {
		return {
			...base,
			cwd,
			durationMs: 0,
			status: "refused",
			truncated: false,
			stdoutBytes: 0,
			stderrBytes: 0,
			outputExcerpt: "",
			refusalReason: `cwd ${command.cwd} resolves outside the workspace`,
		};
	}

	return await new Promise<PolicyRunOutcome>((resolveRun) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command.executable, command.argv, {
				cwd,
				shell: false,
				detached: true,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolveRun({
				...base,
				cwd,
				durationMs: Date.now() - started,
				status: "spawn-failed",
				truncated: false,
				stdoutBytes: 0,
				stderrBytes: 0,
				outputExcerpt: "",
				refusalReason: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		const stdout = newStream();
		const stderr = newStream();
		let settled = false;
		let killed: "timeout" | "cancelled" | undefined;
		let spawnError: Error | undefined;

		const finish = (extra: Partial<PolicyRunOutcome> & { status: PolicyRunStatus }) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			const outputExcerpt = excerptFor(stdout, stderr, command);
			// Only stdout: the artifact is the raw stream. Both streams: a
			// stderr section is appended so the raw stdout bytes stay intact.
			const retained: Buffer[] = [...stdout.chunks];
			if (stderr.chunks.length > 0) {
				if (retained.length > 0) {
					retained.push(Buffer.from("\n"));
				}
				retained.push(Buffer.from("stderr:\n"), ...stderr.chunks);
			}
			const artifactPromise =
				options.artifactStore && retained.length > 0
					? options.artifactStore.writeArtifact(Buffer.concat(retained)).catch(() => undefined)
					: Promise.resolve(undefined);

			void artifactPromise.then((artifact) => {
				resolveRun({
					...base,
					cwd,
					durationMs: Date.now() - started,
					truncated: stdout.truncated || stderr.truncated,
					stdoutBytes: stdout.bytes,
					stderrBytes: stderr.bytes,
					outputExcerpt,
					...(artifact !== undefined ? { artifact } : {}),
					...extra,
				});
			});
		};

		const onAbort = () => {
			if (settled || child.pid === undefined) {
				return;
			}
			killed = "cancelled";
			killProcessTree(child.pid);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const timer = setTimeout(() => {
			if (settled || child.pid === undefined) {
				return;
			}
			killed = "timeout";
			killProcessTree(child.pid);
		}, command.timeoutMs);

		child.once("error", (error) => {
			spawnError = error;
		});
		child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk, command.maxOutputBytes));
		child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk, command.maxOutputBytes));

		child.once("close", (code, termSignal) => {
			if (spawnError !== undefined) {
				finish({
					status: "spawn-failed",
					refusalReason: spawnError.message,
				});
				return;
			}
			if (killed === "timeout") {
				finish({ status: "timeout", ...(termSignal ? { signal: termSignal } : {}) });
				return;
			}
			if (killed === "cancelled") {
				finish({ status: "cancelled", ...(termSignal ? { signal: termSignal } : {}) });
				return;
			}
			finish({
				status: code === 0 ? "passed" : "failed",
				...(code !== null ? { exitCode: code } : {}),
				...(termSignal ? { signal: termSignal } : {}),
			});
		});
	});
}
