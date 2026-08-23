import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { spawnProcess } from "../../utils/child-process.ts";

export const LSP_MAX_HEADER_BYTES = 8 * 1024;
export const LSP_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const LSP_MAX_STDERR_TAIL_BYTES = 64 * 1024;

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const TERMINATE_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;

export interface LspClientOptions {
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly initializationTimeoutMs?: number;
	readonly requestTimeoutMs?: number;
}

export interface LspNotification {
	readonly method: string;
	readonly params?: unknown;
}

export type LspTextDocumentSyncKind = "none" | "full" | "incremental";

export interface LspTextDocumentSync {
	readonly kind: LspTextDocumentSyncKind;
	readonly openClose: boolean;
	readonly save: boolean;
	readonly saveIncludeText: boolean;
}

export class LspJsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(error: { code: number; message: string; data?: unknown }) {
		super(error.message);
		this.name = "LspJsonRpcError";
		this.code = error.code;
		this.data = error.data;
	}
}

type JsonRpcId = number;
type PendingRequest = {
	resolve(value: unknown): void;
	reject(reason: Error): void;
};

type ClientState = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

type JsonRpcMessage = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is string | number {
	return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function parseTextDocumentSync(value: unknown): LspTextDocumentSync {
	let kind: LspTextDocumentSyncKind = "none";
	let openClose = false;
	let save = false;
	let saveIncludeText = false;
	if (typeof value === "number") {
		kind = value === 1 ? "full" : value === 2 ? "incremental" : "none";
	} else if (isRecord(value)) {
		openClose = value.openClose === true;
		kind = value.change === 1 ? "full" : value.change === 2 ? "incremental" : "none";
		if (value.save === true) save = true;
		else if (isRecord(value.save)) {
			save = true;
			saveIncludeText = value.save.includeText === true;
		}
	}
	return { kind, openClose, save, saveIncludeText };
}

function validateTimeout(value: number | undefined, fallback: number, label: string): number {
	const timeout = value ?? fallback;
	if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error(`${label} must be a positive safe integer.`);
	return timeout;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bounded JSON-RPC 2.0 client for one language server's stdio. */
export class LspClient {
	private readonly options: LspClientOptions;
	private child: ChildProcess | undefined;
	private stdin: Writable | undefined;
	private stdout: Readable | undefined;
	private input = Buffer.alloc(0);
	private stderrTail = Buffer.alloc(0);
	private nextRequestId = 1;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly notificationListeners = new Set<(notification: LspNotification) => void>();
	private readonly failureListeners = new Set<(error: Error) => void>();
	private startPromise: Promise<void> | undefined;
	private disposePromise: Promise<void> | undefined;
	private state: ClientState = "idle";
	private failure: Error | undefined;
	private writeChain: Promise<void> = Promise.resolve();
	private syncCapabilities: LspTextDocumentSync = {
		kind: "none",
		openClose: false,
		save: false,
		saveIncludeText: false,
	};

	constructor(options: LspClientOptions) {
		this.options = options;
	}

	get capturedStderr(): string {
		return this.stderrTail.toString("utf8");
	}

	/** Text-document synchronization negotiated during initialization. */
	get textDocumentSync(): LspTextDocumentSync {
		return this.syncCapabilities;
	}

	onNotification(listener: (notification: LspNotification) => void): () => void {
		this.notificationListeners.add(listener);
		return () => this.notificationListeners.delete(listener);
	}

	/** Subscribe to the first terminal protocol or process failure. */
	onFailure(listener: (error: Error) => void): () => void {
		this.failureListeners.add(listener);
		if (this.failure) listener(this.failure);
		return () => this.failureListeners.delete(listener);
	}

	start(): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.state === "closing" || this.state === "closed") {
			return Promise.reject(new Error("Language server client is disposed."));
		}
		if (!this.startPromise) {
			this.state = "starting";
			this.startPromise = this.initialize().catch(async (error) => {
				const failure = normalizeError(error);
				this.fail(failure);
				await this.terminateChild();
				throw failure;
			});
		}
		return this.startPromise;
	}

	async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		await this.start();
		if (this.state !== "ready") throw this.failure ?? new Error("Language server did not become ready.");
		return this.sendRequest(method, params, signal, this.requestTimeoutMs());
	}

	notify(method: string, params?: unknown): void {
		if (this.failure) throw this.failure;
		const exitFailure = this.childExitFailure();
		if (exitFailure) {
			this.fail(exitFailure);
			throw exitFailure;
		}
		if (this.state !== "ready") throw new Error("Language server is not ready.");
		void this.enqueueWrite({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }).catch((error) => {
			this.fail(normalizeError(error));
		});
	}

	dispose(): Promise<void> {
		if (!this.disposePromise) this.disposePromise = this.disposeProcess();
		return this.disposePromise;
	}

	private initializationTimeoutMs(): number {
		return validateTimeout(
			this.options.initializationTimeoutMs,
			DEFAULT_INITIALIZATION_TIMEOUT_MS,
			"initializationTimeoutMs",
		);
	}

	private requestTimeoutMs(): number {
		return validateTimeout(this.options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
	}

	private async initialize(): Promise<void> {
		const child = spawnProcess(this.options.command, [...(this.options.args ?? [])], {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!child.stdin || !child.stdout) {
			child.kill();
			throw new Error("Language server must expose piped stdin and stdout.");
		}
		this.child = child;
		this.stdin = child.stdin;
		this.stdout = child.stdout;
		this.stdout.on("data", (chunk: Buffer | string) => this.onData(chunk));
		child.stderr?.on("data", (chunk: Buffer | string) => this.captureStderr(chunk));
		child.stdin.on("error", (error) => {
			void this.writeFailure(error).then((failure) => this.fail(failure));
		});
		child.once("error", (error) => this.fail(error));
		child.once("exit", (code, signal) => {
			if (this.state !== "closing" && this.state !== "closed") {
				this.fail(new Error(`Language server exited before shutdown (code=${code} signal=${signal}).`));
			}
		});

		const initializeResult = await this.sendRequest(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "Apex Code" },
				rootUri: pathToFileURL(this.options.cwd).href,
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					workspace: { workspaceFolders: false },
					textDocument: {
						definition: {},
						references: {},
						documentSymbol: {},
						publishDiagnostics: { versionSupport: true },
					},
				},
				workspaceFolders: null,
			},
			undefined,
			this.initializationTimeoutMs(),
			"Language server initialize timed out",
		);
		if (!isRecord(initializeResult) || !isRecord(initializeResult.capabilities)) {
			throw new Error("Language server returned an invalid initialize result.");
		}
		this.syncCapabilities = parseTextDocumentSync(initializeResult.capabilities.textDocumentSync);
		if (this.state !== "starting") throw new Error("Language server initialization was interrupted.");
		await this.enqueueWrite({ jsonrpc: "2.0", method: "initialized", params: {} });
		this.state = "ready";
	}

	private async disposeProcess(): Promise<void> {
		if (this.state === "closed") return;
		const wasReady = this.state === "ready";
		this.state = "closing";
		this.rejectPending(new Error("Language server client is closing."));

		if (wasReady) {
			try {
				await this.sendRequest(
					"shutdown",
					undefined,
					undefined,
					SHUTDOWN_TIMEOUT_MS,
					"Language server shutdown timed out",
					true,
				);
				await this.enqueueWrite({ jsonrpc: "2.0", method: "exit" });
			} catch {
				// Bounded termination below is the fallback for an uncooperative server.
			}
		}
		await this.terminateChild();
		this.stdin?.end();
		this.state = "closed";
	}

	private async terminateChild(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const graceful = await Promise.race([exited.then(() => true), delay(TERMINATE_GRACE_MS).then(() => false)]);
		if (graceful) return;
		child.kill("SIGTERM");
		const terminated = await Promise.race([exited.then(() => true), delay(KILL_GRACE_MS).then(() => false)]);
		if (terminated) return;
		child.kill("SIGKILL");
		await exited;
	}

	private sendRequest(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
		timeoutMs?: number,
		timeoutMessage = `Language server request ${method} timed out`,
		allowClosing = false,
	): Promise<unknown> {
		if (this.failure && !allowClosing) return Promise.reject(this.failure);
		const exitFailure = this.childExitFailure();
		if (exitFailure && !allowClosing) {
			this.fail(exitFailure);
			return Promise.reject(exitFailure);
		}
		if ((!allowClosing && (this.state === "closing" || this.state === "closed")) || this.state === "failed") {
			return Promise.reject(this.failure ?? new Error("Language server client is disposed."));
		}
		const id = this.nextRequestId++;
		if (!Number.isSafeInteger(id)) return Promise.reject(new Error("Language server request id space exhausted."));
		if (signal?.aborted)
			return Promise.reject(normalizeError(signal.reason ?? new Error("Language server request aborted.")));

		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const settle = (fn: () => void) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				fn();
			};
			const abort = () => {
				if (!this.pending.delete(id)) return;
				void this.enqueueWrite({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }).catch(() => {});
				settle(() => reject(normalizeError(signal?.reason ?? new Error("Language server request aborted."))));
			};
			this.pending.set(id, {
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					if (!this.pending.delete(id)) return;
					void this.enqueueWrite({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }).catch(() => {});
					settle(() => reject(new Error(`${timeoutMessage} after ${timeoutMs}ms.`)));
				}, timeoutMs);
			}
			void this.enqueueWrite({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch(
				(error) => {
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					pending.reject(normalizeError(error));
				},
			);
		});
	}

	private enqueueWrite(message: object): Promise<void> {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		if (body.length > LSP_MAX_MESSAGE_BYTES)
			return Promise.reject(new Error("Language server message exceeds 8 MiB."));
		const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
		const writing = this.writeChain.then(() => this.writeFrame(frame));
		this.writeChain = writing.catch(() => {});
		return writing;
	}

	private writeFrame(frame: Buffer): Promise<void> {
		const stream = this.stdin;
		if (!stream || stream.destroyed || !stream.writable) {
			return Promise.reject(new Error("Language server stdin is not writable."));
		}
		return new Promise((resolve, reject) => {
			let waitingForDrain = false;
			const cleanup = () => {
				stream.removeListener("error", onError);
				stream.removeListener("drain", onDrain);
			};
			const onError = (error: Error) => {
				cleanup();
				void this.writeFailure(error).then(reject);
			};
			const onDrain = () => {
				waitingForDrain = false;
				cleanup();
				resolve();
			};
			stream.once("error", onError);
			const accepted = stream.write(frame, (error) => {
				if (error) onError(error);
				else if (!waitingForDrain) {
					cleanup();
					resolve();
				}
			});
			if (!accepted) {
				waitingForDrain = true;
				stream.once("drain", onDrain);
			}
		});
	}

	private onData(chunk: Buffer | string): void {
		if (this.failure) return;
		this.input = Buffer.concat([this.input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
		while (true) {
			const headerEnd = this.input.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (this.input.length > LSP_MAX_HEADER_BYTES) this.fail(new Error("Language server header exceeds 8 KiB."));
				return;
			}
			if (headerEnd > LSP_MAX_HEADER_BYTES) {
				this.fail(new Error("Language server header exceeds 8 KiB."));
				return;
			}
			const header = this.input.subarray(0, headerEnd).toString("ascii");
			const lengths = [...header.matchAll(/(?:^|\r\n)Content-Length:\s*(\d+)(?=\r\n|$)/gi)];
			if (lengths.length !== 1) {
				this.fail(new Error("Language server frame must contain exactly one Content-Length header."));
				return;
			}
			const contentLength = Number(lengths[0][1]);
			if (!Number.isSafeInteger(contentLength) || contentLength > LSP_MAX_MESSAGE_BYTES) {
				this.fail(new Error("Language server message exceeds 8 MiB."));
				return;
			}
			const bodyStart = headerEnd + 4;
			if (this.input.length < bodyStart + contentLength) return;
			const body = this.input.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
			this.input = this.input.subarray(bodyStart + contentLength);
			try {
				const parsed: unknown = JSON.parse(body);
				if (!isRecord(parsed)) throw new Error("Language server JSON-RPC message must be an object.");
				this.onMessage(parsed);
			} catch (error) {
				this.fail(normalizeError(error));
				return;
			}
		}
	}

	private onMessage(message: JsonRpcMessage): void {
		if (message.jsonrpc !== "2.0") {
			this.fail(new Error('Language server message must declare jsonrpc "2.0".'));
			return;
		}
		if (typeof message.method === "string") {
			if (message.id !== undefined && message.id !== null) {
				void this.handleServerRequest(message);
				return;
			}
			const notification: LspNotification = {
				method: message.method,
				...(message.params === undefined ? {} : { params: message.params }),
			};
			for (const listener of this.notificationListeners) listener(notification);
			return;
		}
		if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		const hasResult = Object.hasOwn(message, "result");
		const hasError = Object.hasOwn(message, "error");
		if (hasResult === hasError) {
			this.fail(new Error("Language server response must contain exactly one of result or error."));
			return;
		}
		this.pending.delete(message.id);
		if (hasError) {
			const error = message.error;
			if (!isRecord(error) || !Number.isSafeInteger(error.code) || typeof error.message !== "string") {
				this.fail(new Error("Language server returned an invalid JSON-RPC error."));
				return;
			}
			pending.reject(new LspJsonRpcError({ code: error.code as number, message: error.message, data: error.data }));
			return;
		}
		pending.resolve(message.result);
	}

	private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
		if (!isJsonRpcId(message.id) || typeof message.method !== "string") return;
		let result: unknown;
		let error: { code: number; message: string } | undefined;
		switch (message.method) {
			case "workspace/configuration": {
				const params = message.params;
				if (!isRecord(params) || !Array.isArray(params.items)) error = { code: -32602, message: "Invalid params" };
				else result = params.items.map(() => null);
				break;
			}
			case "workspace/workspaceFolders":
			case "window/showMessageRequest":
				result = null;
				break;
			case "client/registerCapability":
			case "client/unregisterCapability":
			case "window/workDoneProgress/create":
			case "workspace/semanticTokens/refresh":
			case "workspace/inlayHint/refresh":
			case "workspace/diagnostic/refresh":
			case "workspace/codeLens/refresh":
				result = null;
				break;
			case "workspace/applyEdit":
				result = { applied: false, failureReason: "Apex Code does not accept server-initiated workspace edits." };
				break;
			case "window/showDocument":
				result = { success: false };
				break;
			default:
				error = { code: -32601, message: "Method not found" };
		}
		await this.enqueueWrite({
			jsonrpc: "2.0",
			id: message.id,
			...(error ? { error } : { result }),
		}).catch((writeError) => this.fail(normalizeError(writeError)));
	}

	private captureStderr(chunk: Buffer | string): void {
		const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		this.stderrTail = Buffer.concat([this.stderrTail, bytes]);
		if (this.stderrTail.length > LSP_MAX_STDERR_TAIL_BYTES) {
			this.stderrTail = this.stderrTail.subarray(this.stderrTail.length - LSP_MAX_STDERR_TAIL_BYTES);
		}
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	private childExitFailure(): Error | undefined {
		const child = this.child;
		if (!child || (child.exitCode === null && child.signalCode === null)) return undefined;
		return new Error(`Language server exited before shutdown (code=${child.exitCode} signal=${child.signalCode}).`);
	}

	private async writeFailure(error: Error): Promise<Error> {
		const exitFailure = this.childExitFailure();
		if (exitFailure || (error as NodeJS.ErrnoException).code !== "EPIPE" || !this.child) return exitFailure ?? error;
		await Promise.race([new Promise<void>((resolve) => this.child?.once("exit", () => resolve())), delay(1_000)]);
		return this.childExitFailure() ?? error;
	}

	private fail(error: Error): void {
		if (this.state === "closed") return;
		const firstFailure = this.failure === undefined;
		this.failure ??= error;
		if (this.state !== "closing") this.state = "failed";
		this.rejectPending(this.failure);
		if (firstFailure) for (const listener of this.failureListeners) listener(this.failure);
	}
}
