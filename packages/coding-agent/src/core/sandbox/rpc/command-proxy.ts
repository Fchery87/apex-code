import { chmodSync, existsSync, mkdtempSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import { supervisorTempDirectory } from "../supervisor-temp.ts";
import type { SandboxViolationStore } from "../violations.ts";
import { FrameReader, isRequestObject, writeFrame } from "./framing.ts";

/** AF_UNIX `sun_path` is 108 bytes on Linux, including the terminating NUL. */
const SUN_PATH_LIMIT = 108;
const MAX_CONNECTIONS = 8;

/** Env var naming the child-side socket. */
export const COMMAND_ESCALATION_SOCKET_VARIABLE = "APEX_COMMAND_ESCALATION_PATH";

export interface CommandEscalationRequest {
	readonly command: string;
	/** The one directory the command needs writable that it does not already have. */
	readonly writableRoot: string;
}

export interface CommandEscalationResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface CommandEscalationChannelPaths {
	readonly hostSocketDirectory: string;
	readonly hostSocketPath: string;
	readonly childSocketPath: string;
}

export function resolveCommandEscalationChannelPaths(): CommandEscalationChannelPaths {
	const hostSocketDirectory = mkdtempSync(join(supervisorTempDirectory(), `apex-escalate-${process.pid}-`), {
		encoding: "utf8",
	});
	chmodSync(hostSocketDirectory, 0o700);
	const hostSocketPath = join(hostSocketDirectory, "channel.sock");
	if (Buffer.byteLength(hostSocketPath) + 1 > SUN_PATH_LIMIT) {
		throw new Error("Command escalation channel path exceeds the Unix socket path limit.");
	}
	const childSocketPath = process.platform === "linux" ? "/home/apex-command-escalation.sock" : hostSocketPath;
	return { hostSocketDirectory, hostSocketPath, childSocketPath };
}

/**
 * Run one approved command in a second, differently-mounted child.
 *
 * A refused write is refused by the kernel inside a namespace whose mounts are fixed for
 * its lifetime. There is no in-place equivalent of holding a CONNECT open while a human
 * decides: the syscall has already failed, and nothing inside the namespace can widen it.
 * So the escalation happens where the authority is, outside the boundary, by starting a
 * separate child for that one command.
 *
 * The original child's namespace is never modified, which is what makes this sound rather
 * than a hole. Approving one command grants nothing to the session it came from; the
 * session's own next attempt at the same operation is refused exactly as before.
 *
 * Approval is the supervisor's, per ADR 0023, for the reason that ADR gives: this socket
 * has no peer authentication, so a request arriving on it may have come from anything
 * inside the boundary. Without an approver the channel refuses, which is what keeps
 * headless, print, JSON, and RPC modes at ADR 0005's deny.
 */
export function createCommandEscalationProxy(options: {
	socketPath: string;
	/** Ask a human. Absent means refuse without asking. */
	requestApproval?: (request: CommandEscalationRequest) => Promise<boolean>;
	/** Start the second child. Supplied by the platform backend, which owns mount shape. */
	runEscalated: (request: CommandEscalationRequest) => Promise<CommandEscalationResult>;
	violationStore?: SandboxViolationStore;
}): Promise<{ close(): Promise<void> }> {
	function audit(detail: string, command: string): void {
		options.violationStore?.add({ kind: "filesystem", command, detail, timestamp: new Date() });
	}

	async function answer(request: unknown): Promise<object> {
		if (!isRequestObject(request)) return { ok: false, error: "Malformed request." };
		if (request.op !== "run") return { ok: false, error: "Only command escalation is served here." };
		const command = typeof request.command === "string" ? request.command : "";
		const writableRoot = typeof request.writableRoot === "string" ? request.writableRoot : "";
		if (!command || !writableRoot) return { ok: false, error: "Request named no command or no root." };

		// Every request is asked about individually. There is no session-scoped grant here,
		// unlike a host or a credential: a command is not a stable subject to remember, and
		// remembering one would silently cover the next command that named the same root.
		if (!options.requestApproval) {
			audit(`Refused an escalation with no way to ask: ${command}`, command);
			return { ok: false, error: "Escalation is unavailable without a terminal." };
		}
		let approved = false;
		try {
			approved = await options.requestApproval({ command, writableRoot });
		} catch {
			approved = false;
		}
		if (!approved) {
			audit(`Escalation refused for ${writableRoot}`, command);
			return { ok: false, error: "Escalation was refused." };
		}
		const result = await options.runEscalated({ command, writableRoot });
		audit(`Escalated with ${writableRoot} writable, exit ${result.code}`, command);
		return { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr };
	}

	return new Promise((resolve, reject) => {
		if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
		const sockets = new Set<net.Socket>();
		const server = net.createServer((socket) => {
			if (sockets.size >= MAX_CONNECTIONS) {
				socket.destroy();
				return;
			}
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => socket.destroy());
			const reader = new FrameReader(socket, "Command escalation channel", (detail) =>
				audit(`Refused: ${detail}`, "(protocol)"),
			);
			void (async () => {
				try {
					writeFrame(socket, await answer(await reader.next()));
				} catch {
					// A disconnected or malformed client is the reader's business.
				} finally {
					socket.end();
				}
			})();
		});
		server.on("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			try {
				chmodSync(options.socketPath, 0o600);
			} catch {
				// The containing directory is already 0700; this is defence in depth.
			}
			resolve({
				close: () =>
					new Promise((closed) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => closed());
					}),
			});
		});
	});
}
