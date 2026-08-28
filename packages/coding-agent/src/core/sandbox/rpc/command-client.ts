import * as net from "node:net";
import { dirname, isAbsolute } from "node:path";
import { COMMAND_ESCALATION_SOCKET_VARIABLE } from "./command-proxy.ts";

/**
 * The child's side of per-command escalation.
 *
 * The path this extracts is a guess, and it is allowed to be, because nothing safe rests
 * on it. The supervisor shows the human the exact command and the exact root before
 * anything runs, so a bad guess is refused by someone reading it rather than silently
 * granted. What the guess buys is not having to make the user work out which directory to
 * name; when it finds nothing, no escalation is offered and the command fails as it did
 * before.
 */

/** The wordings the kernel and the shell actually produce for a mount refusal. */
const REFUSAL_PATTERNS: readonly RegExp[] = [
	/cannot (?:create|touch|remove|open) ['"]?([^'":]+)['"]?: (?:Read-only file system|Permission denied)/i,
	/^[^:]*: ?([/][^\s:]+): (?:Operation not permitted|Permission denied|Read-only file system)/im,
	/(?:EROFS|EACCES|EPERM)[^'"]*['"]([/][^'"]+)['"]/,
];

/** The absolute path a sandbox filesystem refusal named, if the output named one. */
export function extractRefusedPath(output: string): string | undefined {
	for (const pattern of REFUSAL_PATTERNS) {
		const match = pattern.exec(output);
		const candidate = match?.[1]?.trim();
		if (candidate && isAbsolute(candidate)) return candidate;
	}
	return undefined;
}

/** True when the output looks like the boundary refused a write rather than the command failing. */
export function looksLikeSandboxRefusal(output: string): boolean {
	return /Read-only file system|Operation not permitted|Permission denied/i.test(output);
}

/**
 * The directory an escalation should make writable for a refused path.
 *
 * The parent, not the file: the command was creating something that does not exist, and a
 * bind of a non-existent path is not a mount bwrap can make.
 */
export function escalationRootFor(refusedPath: string): string {
	return dirname(refusedPath);
}

export interface EscalationOutcome {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Ask the supervisor to run one command with one extra writable root.
 *
 * Resolves undefined for every refusal and every failure alike, because the caller's
 * behaviour is identical in both cases: report the original error. Only a command that
 * actually ran returns anything.
 */
export function requestCommandEscalation(
	request: { command: string; writableRoot: string },
	socketPath = process.env[COMMAND_ESCALATION_SOCKET_VARIABLE],
): Promise<EscalationOutcome | undefined> {
	if (!socketPath) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const socket = net.connect(socketPath);
		let buffer = "";
		const giveUp = () => {
			socket.destroy();
			resolve(undefined);
		};
		socket.on("connect", () => socket.write(`${JSON.stringify({ op: "run", ...request })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			socket.destroy();
			try {
				const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
				if (response.ok === true && typeof response.code === "number") {
					resolve({
						code: response.code,
						stdout: typeof response.stdout === "string" ? response.stdout : "",
						stderr: typeof response.stderr === "string" ? response.stderr : "",
					});
					return;
				}
			} catch {
				// Fall through to the same undefined a refusal produces.
			}
			resolve(undefined);
		});
		socket.on("error", giveUp);
	});
}
