/**
 * Supervisor-owned credential mutation service for sandboxed sessions.
 *
 * Reads stay on the read-only auth.json projection. Mutations cross this Unix socket
 * and execute under the host AuthStorage lock. The child can therefore implement the
 * CredentialStore serialized read-modify-write contract without gaining filesystem
 * write access to the credential file.
 */

import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as net from "node:net";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../auth-storage.ts";
import { getConfigValueEnvVarNames, isCommandConfigValue } from "../../resolve-config-value.ts";
import type { SandboxViolationStore } from "../violations.ts";

/** AF_UNIX `sun_path` is 108 bytes on Linux, including the terminating NUL. */
const SUN_PATH_LIMIT = 108;
/** Credentials are small; reject larger frames before UTF-8 decoding or JSON parsing. */
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 32;
const CONNECTION_IDLE_TIMEOUT_MS = 30_000;

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Reclaim only same-user directories whose encoded supervisor PID is dead. */
function reclaimStaleCredentialChannelDirectories(): void {
	let entries: string[];
	try {
		entries = readdirSync("/tmp");
	} catch {
		return;
	}
	for (const entry of entries) {
		const match = /^apex-cred-(\d+)-[A-Za-z0-9_-]+$/.exec(entry);
		if (!match) continue;
		const pid = Number(match[1]);
		if (!Number.isSafeInteger(pid) || pid < 1 || processIsAlive(pid)) continue;
		const path = join("/tmp", entry);
		try {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.uid !== process.getuid?.()) continue;
			rmSync(path, { force: true, recursive: true });
		} catch {
			// Another launch may have reclaimed it first.
		}
	}
}

export interface CredentialChannelPaths {
	readonly hostSocketDirectory: string;
	readonly hostSocketPath: string;
	readonly childSocketPath: string;
}

/**
 * Allocate the endpoint beneath a private fixed-root directory.
 *
 * Do not honor TMPDIR here. It can point inside the workspace on macOS, where the
 * sandbox may write it. A fresh 0700 directory under /tmp also removes the
 * listen-before-chmod authorization race: no other account can reach the socket while
 * Node applies its initial umask-derived mode.
 */
export function resolveCredentialChannelPaths(): CredentialChannelPaths {
	reclaimStaleCredentialChannelDirectories();
	const hostSocketDirectory = mkdtempSync(`/tmp/apex-cred-${process.pid}-`, { encoding: "utf8" });
	chmodSync(hostSocketDirectory, 0o700);
	const hostSocketPath = join(hostSocketDirectory, "channel.sock");
	if (Buffer.byteLength(hostSocketPath) + 1 > SUN_PATH_LIMIT) {
		rmSync(hostSocketDirectory, { force: true, recursive: true });
		throw new Error("Credential channel path exceeds the Unix socket path limit.");
	}
	const childSocketPath = process.platform === "linux" ? "/home/apex-credential-channel.sock" : hostSocketPath;
	return { hostSocketDirectory, hostSocketPath, childSocketPath };
}

export interface CredentialProxy {
	close(): Promise<void>;
}

export interface CredentialConfigReference {
	readonly field: string;
	readonly kind: "command" | "environment";
}

/** Find a config-value reference without recursively walking attacker-controlled input. */
export function findCredentialConfigReference(credential: unknown): CredentialConfigReference | undefined {
	const pending: Array<{ value: unknown; field: string }> = [{ value: credential, field: "" }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		if (typeof current.value === "string") {
			if (isCommandConfigValue(current.value)) return { field: current.field, kind: "command" };
			if (getConfigValueEnvVarNames(current.value).length > 0) {
				return { field: current.field, kind: "environment" };
			}
			continue;
		}
		if (Array.isArray(current.value)) {
			for (let index = current.value.length - 1; index >= 0; index--) {
				pending.push({ value: current.value[index], field: `${current.field}[${index}]` });
			}
			continue;
		}
		if (current.value !== null && typeof current.value === "object") {
			const entries = Object.entries(current.value);
			for (let index = entries.length - 1; index >= 0; index--) {
				const [key, value] = entries[index]!;
				pending.push({ value, field: current.field ? `${current.field}.${key}` : key });
			}
		}
	}
	return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

/** Runtime validation at the untrusted child-to-host boundary. */
export function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const credential = value as Record<string, unknown>;
	if (credential.type === "api_key") {
		return (
			(credential.key === undefined || typeof credential.key === "string") &&
			(credential.env === undefined || isStringRecord(credential.env))
		);
	}
	return (
		credential.type === "oauth" &&
		typeof credential.access === "string" &&
		typeof credential.refresh === "string" &&
		typeof credential.expires === "number" &&
		Number.isFinite(credential.expires)
	);
}

function referenceRefusal(reference: CredentialConfigReference): string {
	return (
		`Credential values written from a sandboxed session must be literal secrets: field ` +
		`"${reference.field}" contains a ${reference.kind} reference. To store a reference, ` +
		`edit the credential file on the host directly or use the provider environment variable.`
	);
}

interface StartRequest {
	readonly action?: unknown;
	readonly providerId?: unknown;
}

interface CommitRequest {
	readonly action?: unknown;
	readonly credential?: unknown;
}

function writeFrame(socket: net.Socket, response: object): void {
	if (socket.destroyed) return;
	const frame = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
	if (frame.length > MAX_FRAME_BYTES) {
		throw new Error("Credential channel response exceeded its byte limit.");
	}
	socket.write(frame);
}

class FrameReader {
	private readonly socket: net.Socket;
	private readonly onProtocolRefusal: (detail: string) => void;
	private buffer = Buffer.alloc(0);
	private readonly queued: unknown[] = [];
	private readonly waiting: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
	private terminalError: Error | undefined;

	constructor(socket: net.Socket, onProtocolRefusal: (detail: string) => void) {
		this.socket = socket;
		this.onProtocolRefusal = onProtocolRefusal;
		socket.on("data", (chunk: Buffer) => this.push(chunk));
		socket.on("close", () => this.fail(new Error("Credential channel client disconnected.")));
		socket.on("error", (error) => this.fail(error));
	}

	next(): Promise<unknown> {
		const queued = this.queued.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.terminalError) return Promise.reject(this.terminalError);
		return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
	}

	private push(chunk: Buffer): void {
		if (this.terminalError) return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const newline = this.buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.buffer.length > MAX_FRAME_BYTES) this.rejectOversizedFrame();
				return;
			}
			if (newline > MAX_FRAME_BYTES) {
				this.rejectOversizedFrame();
				return;
			}
			const frame = this.buffer.subarray(0, newline);
			this.buffer = this.buffer.subarray(newline + 1);
			if (frame.length === 0) continue;
			let value: unknown;
			try {
				value = JSON.parse(frame.toString("utf8")) as unknown;
			} catch {
				this.onProtocolRefusal("Invalid request frame: not JSON.");
				writeFrame(this.socket, { ok: false, error: "Invalid request frame: not JSON." });
				this.fail(new Error("Invalid credential channel JSON frame."));
				this.socket.end();
				return;
			}
			const waiter = this.waiting.shift();
			if (waiter) {
				waiter.resolve(value);
			} else if (this.queued.length === 0) {
				this.queued.push(value);
			} else {
				this.onProtocolRefusal("Unexpected pipelined request frame.");
				writeFrame(this.socket, { ok: false, error: "Unexpected pipelined request frame." });
				this.fail(new Error("Credential channel received an unexpected pipelined frame."));
				this.socket.end();
				return;
			}
		}
	}

	private rejectOversizedFrame(): void {
		this.onProtocolRefusal("Request frame exceeded the 64 KiB byte limit.");
		writeFrame(this.socket, { ok: false, error: "Request frame is too large." });
		this.fail(new Error("Credential channel frame exceeded its byte limit."));
		this.socket.end();
	}

	private fail(error: Error): void {
		if (this.terminalError) return;
		this.terminalError = error;
		for (const waiter of this.waiting.splice(0)) waiter.reject(error);
	}
}

class ChannelRefusal extends Error {
	readonly command: string;

	constructor(command: string, message: string) {
		super(message);
		this.name = "ChannelRefusal";
		this.command = command;
	}
}

function isRequestObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serve serialized credential mutations on one private Unix socket. */
export function createCredentialProxy(options: {
	authPath: string;
	violationStore?: SandboxViolationStore;
	socketPath: string;
	/** Private directory allocated by resolveCredentialChannelPaths; removed on close. */
	cleanupDirectory?: string;
}): Promise<CredentialProxy> {
	return new Promise((resolve, reject) => {
		const authStorage = AuthStorage.create(options.authPath);
		const sockets = new Set<net.Socket>();
		const operations = new Set<Promise<void>>();
		let settled = false;
		let closing: Promise<void> | undefined;

		const audit = (command: string, detail: string): void => {
			options.violationStore?.add({ kind: "unknown", command, detail, timestamp: new Date() });
		};
		const refuse = (socket: net.Socket, command: string, error: string, detail = error): void => {
			audit(command, `Refused: ${detail}`);
			writeFrame(socket, { ok: false, error });
		};

		const handleConnection = async (socket: net.Socket, reader: FrameReader, signal: AbortSignal): Promise<void> => {
			const raw = await reader.next();
			if (!isRequestObject(raw)) {
				refuse(socket, "credential-channel", "Invalid request: expected an object.");
				return;
			}
			const request = raw as StartRequest;
			const providerId = request.providerId;
			if (
				typeof providerId !== "string" ||
				providerId.length === 0 ||
				Buffer.byteLength(providerId, "utf8") > 256 ||
				/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(providerId)
			) {
				refuse(
					socket,
					"credential-channel",
					"Invalid request: providerId contains unsafe characters or is too long.",
				);
				return;
			}
			if (request.action === "delete") {
				await authStorage.delete(providerId, { signal });
				audit(`credential-delete ${providerId}`, "Accepted: credential deleted through the sandbox channel.");
				writeFrame(socket, { ok: true });
				return;
			}
			if (request.action !== "modify") {
				refuse(socket, "credential-channel", 'Invalid request: action must be "modify" or "delete".');
				return;
			}

			let changed = false;
			const result = await authStorage.modify(
				providerId,
				async (current) => {
					writeFrame(socket, { type: "current", ...(current === undefined ? {} : { credential: current }) });
					const rawCommit = await reader.next();
					if (!isRequestObject(rawCommit)) {
						throw new ChannelRefusal(
							`credential-write ${providerId}`,
							"Invalid modify response: expected an object.",
						);
					}
					const commit = rawCommit as CommitRequest;
					if (commit.action === "abort") {
						throw new ChannelRefusal(
							`credential-write ${providerId}`,
							"Credential modification was aborted by the client.",
						);
					}
					if (commit.action === "no_change") return undefined;
					if (commit.action !== "commit") {
						throw new ChannelRefusal(`credential-write ${providerId}`, "Invalid modify response action.");
					}
					if (!isCredential(commit.credential)) {
						throw new ChannelRefusal(`credential-write ${providerId}`, "Invalid credential shape.");
					}
					const reference = findCredentialConfigReference(commit.credential);
					if (reference) {
						throw new ChannelRefusal(`credential-write ${providerId}`, referenceRefusal(reference));
					}
					changed = true;
					return commit.credential;
				},
				{ signal },
			);
			if (changed) {
				audit(`credential-write ${providerId}`, "Accepted: credential written through the sandbox channel.");
			}
			writeFrame(socket, { ok: true, ...(result === undefined ? {} : { credential: result }) });
		};

		const server = net.createServer((socket) => {
			if (sockets.size >= MAX_CONNECTIONS) {
				refuse(socket, "credential-channel", "Credential channel connection limit reached.");
				socket.end();
				return;
			}
			sockets.add(socket);
			const controller = new AbortController();
			socket.setTimeout(CONNECTION_IDLE_TIMEOUT_MS, () => {
				audit("credential-channel", "Refused: credential channel connection timed out.");
				socket.destroy(new Error("Credential channel connection timed out."));
			});
			socket.on("close", () => {
				sockets.delete(socket);
				controller.abort();
			});
			const reader = new FrameReader(socket, (detail) => audit("credential-channel", `Refused: ${detail}`));
			const operation = handleConnection(socket, reader, controller.signal)
				.catch((error: unknown) => {
					if (error instanceof ChannelRefusal) {
						refuse(socket, error.command, error.message);
						return;
					}
					refuse(
						socket,
						"credential-channel",
						"The host credential operation failed.",
						"Host credential operation failed without exposing credential data.",
					);
				})
				.finally(() => {
					operations.delete(operation);
					socket.end();
				});
			operations.add(operation);
		});

		const cleanup = (): void => {
			rmSync(options.socketPath, { force: true });
			if (options.cleanupDirectory) rmSync(options.cleanupDirectory, { force: true, recursive: true });
		};
		const failStartup = (error: Error): void => {
			if (settled) return;
			settled = true;
			server.close();
			for (const socket of sockets) socket.destroy();
			cleanup();
			reject(error);
		};
		server.once("error", failStartup);
		server.listen(options.socketPath, () => {
			try {
				chmodSync(options.socketPath, 0o600);
			} catch (error) {
				failStartup(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			settled = true;
			server.off("error", failStartup);
			resolve({
				close: () => {
					if (closing) return closing;
					closing = (async () => {
						for (const socket of sockets) socket.destroy();
						await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
						await Promise.allSettled([...operations]);
						cleanup();
					})();
					return closing;
				},
			});
		});
	});
}
