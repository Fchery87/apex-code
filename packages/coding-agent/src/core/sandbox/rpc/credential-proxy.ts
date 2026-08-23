/**
 * Supervisor-side writer for the sandbox credential channel.
 *
 * Spec: `docs/specs/2026-08-22-supervisor-mediated-credential-writes.md`. The sandboxed
 * child cannot write `auth.json` -- the file is bind-mounted read-only by design (ADR
 * 0015) -- so credential *writes* from `/login` and OAuth refresh travel a unix socket
 * owned by this process, while reads keep going to the read-only mount. The channel is
 * deliberately narrow: one request type per credential (write a whole value, or delete),
 * and only literal secrets are accepted.
 *
 * The content constraint is the whole security story of this channel. `bash` runs inside
 * the child, so anything the child can reach, a model-driven command can reach; the
 * socket is therefore reachable by the agent, not just by the human at the TUI. A value
 * the child cannot make the host *execute* turns the worst case into "a provider key was
 * overwritten" (visible in the audit tail) instead of arbitrary host command execution
 * through `resolveConfigValue`'s `!command` and `$VAR` forms.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../auth-storage.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue } from "../../resolve-config-value.ts";
import type { SandboxViolationStore } from "../violations.ts";

/** AF_UNIX `sun_path` is 108 bytes on Linux, including the terminating NUL. */
const SUN_PATH_LIMIT = 108;

/** Credentials are small; a frame larger than this is a misbehaving or hostile client. */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * Where the channel socket lives on each side of the boundary.
 *
 * Same shape as the network proxy's `resolveProxySocketPaths` in `linux-backend.ts`, and
 * for the same reason: the host side needs a short unique path (AF_UNIX caps `sun_path`),
 * while the child side must sit under `/home` on Linux -- the one writable mount at the
 * point bwrap creates the mountpoint. macOS Seatbelt cannot remap a path, so the child
 * there connects to the host path unchanged and the profile allows exactly that socket.
 */
export function resolveCredentialChannelPaths(temporaryDirectory: string = tmpdir()): {
	hostSocketPath: string;
	childSocketPath: string;
} {
	const name = `apex-cred-${process.pid}-${randomBytes(4).toString("hex")}.sock`;
	// An unusually long TMPDIR would reintroduce the very limit this avoids.
	const base = join(temporaryDirectory, name).length + 1 > SUN_PATH_LIMIT ? "/tmp" : temporaryDirectory;
	const hostSocketPath = join(base, name);
	const childSocketPath = process.platform === "linux" ? `/home/${name}` : hostSocketPath;
	return { hostSocketPath, childSocketPath };
}

export interface CredentialProxy {
	close(): Promise<void>;
}

/** A string field of a credential that is a command or variable reference, not a literal. */
export interface CredentialConfigReference {
	readonly field: string;
	readonly value: string;
}

/**
 * Find the first string inside `credential` that `resolveConfigValue` would treat as a
 * command (`!...`) or interpolate (`$VAR`, `${VAR}`) rather than store verbatim.
 *
 * Uses the same parser the resolution path uses (`isCommandConfigValue`,
 * `getConfigValueEnvVarNames`), so the constraint cannot drift from what it defends
 * against. OAuth credentials are walked too: every string field is a future resolution
 * input the day a provider starts reading it, and `access`/`refresh` already are.
 */
export function findCredentialConfigReference(credential: unknown): CredentialConfigReference | undefined {
	let found: CredentialConfigReference | undefined;
	const walk = (node: unknown, field: string): void => {
		if (found) return;
		if (typeof node === "string") {
			if (isCommandConfigValue(node) || getConfigValueEnvVarNames(node).length > 0) {
				found = { field, value: node };
			}
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((entry, index) => {
				walk(entry, `${field}[${index}]`);
			});
			return;
		}
		if (node !== null && typeof node === "object") {
			for (const [key, value] of Object.entries(node)) walk(value, field ? `${field}.${key}` : key);
		}
	};
	walk(credential, "");
	return found;
}

function refusalMessage(reference: CredentialConfigReference): string {
	return (
		`Credential values written from a sandboxed session must be literal secrets: field ` +
		`"${reference.field}" would be resolved as a command or environment reference ` +
		`(${JSON.stringify(reference.value)}). To store such a value, edit the credential ` +
		`file on the host directly or set the provider's environment variable -- both run ` +
		`outside the sandbox, where you, not the agent, are the author.`
	);
}

interface ChannelRequest {
	readonly action?: unknown;
	readonly providerId?: unknown;
	readonly credential?: unknown;
}

type ChannelResponse = { readonly ok: true } | { readonly ok: false; readonly error: string };

function writeResponse(socket: net.Socket, response: ChannelResponse): void {
	if (socket.destroyed) return;
	try {
		socket.write(`${JSON.stringify(response)}\n`);
	} catch {
		// The client is gone; nothing to answer.
	}
}

/**
 * Serve credential writes on one unix socket. One newline-terminated JSON request per
 * frame, one response frame back; a connection may carry several requests. Every accepted
 * write and every refusal is recorded in the violation tail, because the store is the one
 * bounded audit surface the supervisor already prints on exit.
 */
export function createCredentialProxy(options: {
	authPath: string;
	violationStore?: SandboxViolationStore;
	socketPath: string;
}): Promise<CredentialProxy> {
	return new Promise((resolve, reject) => {
		const authStorage = AuthStorage.create(options.authPath);

		const handleFrame = async (socket: net.Socket, line: string): Promise<void> => {
			let request: ChannelRequest;
			try {
				request = JSON.parse(line) as ChannelRequest;
			} catch {
				writeResponse(socket, { ok: false, error: "Invalid request frame: not JSON." });
				return;
			}

			const providerId = request.providerId;
			if (typeof providerId !== "string" || providerId.length === 0) {
				writeResponse(socket, { ok: false, error: "Invalid request: providerId must be a non-empty string." });
				return;
			}

			if (request.action === "delete") {
				try {
					await authStorage.delete(providerId);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					options.violationStore?.add({
						kind: "unknown",
						command: `credential-delete ${providerId}`,
						detail: `Refused: host credential write failed (${detail}).`,
						timestamp: new Date(),
					});
					writeResponse(socket, { ok: false, error: `Failed to delete credential: ${detail}` });
					return;
				}
				options.violationStore?.add({
					kind: "unknown",
					command: `credential-delete ${providerId}`,
					detail: "Accepted: credential deleted through the sandbox channel.",
					timestamp: new Date(),
				});
				writeResponse(socket, { ok: true });
				return;
			}

			if (request.action !== "write") {
				writeResponse(socket, { ok: false, error: 'Invalid request: action must be "write" or "delete".' });
				return;
			}

			const credential = request.credential;
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
				writeResponse(socket, { ok: false, error: "Invalid request: credential must be an object." });
				return;
			}

			const reference = findCredentialConfigReference(credential);
			if (reference) {
				options.violationStore?.add({
					kind: "unknown",
					command: `credential-write ${providerId}`,
					detail: `Refused: ${refusalMessage(reference)}`,
					timestamp: new Date(),
				});
				writeResponse(socket, { ok: false, error: refusalMessage(reference) });
				return;
			}

			const value = credential as Record<string, unknown>;
			try {
				await authStorage.modify(providerId, async () => value as never);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				options.violationStore?.add({
					kind: "unknown",
					command: `credential-write ${providerId}`,
					detail: `Refused: host credential write failed (${detail}).`,
					timestamp: new Date(),
				});
				writeResponse(socket, { ok: false, error: `Failed to write credential: ${detail}` });
				return;
			}
			options.violationStore?.add({
				kind: "unknown",
				command: `credential-write ${providerId}`,
				detail: "Accepted: credential written through the sandbox channel.",
				timestamp: new Date(),
			});
			writeResponse(socket, { ok: true });
		};

		const server = net.createServer((socket) => {
			socket.setEncoding("utf8");
			let buffer = "";
			let closed = false;
			socket.on("data", (chunk: string) => {
				buffer += chunk;
				if (buffer.length > MAX_FRAME_BYTES) {
					socket.destroy();
					return;
				}
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					const frame = line.trim();
					if (frame) void handleFrame(socket, frame);
					newline = buffer.indexOf("\n");
				}
			});
			socket.on("close", () => {
				closed = true;
			});
			socket.on("error", () => {
				if (!closed) socket.destroy();
			});
		});

		server.on("error", reject);

		// A prior launch that never called close() leaves a stale socket file behind;
		// Node's listen() refuses to bind over one even though nothing is listening.
		if (existsSync(options.socketPath)) {
			rmSync(options.socketPath, { force: true });
		}

		server.listen(options.socketPath, () => {
			server.off("error", reject);
			// The socket grants credential writes to whoever can connect; keep that
			// exactly the owning user.
			chmodSync(options.socketPath, 0o600);
			resolve({
				close: () =>
					new Promise<void>((resolveClose) => {
						server.close(() => {
							// Node removes the socket file itself when the server closes
							// (verified on Node 24); `force` keeps this idempotent for any
							// runtime that does not, and covers a double close.
							rmSync(options.socketPath, { force: true });
							resolveClose();
						});
					}),
			});
		});
	});
}
