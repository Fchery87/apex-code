import type * as net from "node:net";

/**
 * The framing both supervisor-owned RPC channels share.
 *
 * Extracted from `credential-proxy.ts` when the git credential channel needed the same
 * reader. A second hand-written copy of a byte-bounded parser sitting on a socket that
 * every process inside the sandbox can reach is exactly the divergence ADR 0010 exists to
 * prevent for tool contracts: a hardening applied to one copy and not the other is
 * invisible until it matters. One implementation, named per channel only in its messages.
 */

export const MAX_FRAME_BYTES = 64 * 1024;

export function writeFrame(socket: net.Socket, response: object): void {
	if (socket.destroyed) return;
	const frame = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
	if (frame.length > MAX_FRAME_BYTES) {
		throw new Error("Channel response exceeded its byte limit.");
	}
	socket.write(frame);
}

export function isRequestObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One request frame at a time, newline-delimited JSON, bounded in bytes.
 *
 * Pipelining is refused rather than queued: a channel that answers a second request before
 * the first is served makes the audit tail ambiguous about which frame a refusal belonged
 * to, and neither channel has a caller that needs it.
 */
export class FrameReader {
	private readonly socket: net.Socket;
	private readonly channelName: string;
	private readonly onProtocolRefusal: (detail: string) => void;
	private buffer = Buffer.alloc(0);
	private readonly queued: unknown[] = [];
	private readonly waiting: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
	private terminalError: Error | undefined;

	constructor(socket: net.Socket, channelName: string, onProtocolRefusal: (detail: string) => void) {
		this.socket = socket;
		this.channelName = channelName;
		this.onProtocolRefusal = onProtocolRefusal;
		socket.on("data", (chunk: Buffer) => this.push(chunk));
		socket.on("close", () => this.fail(new Error(`${channelName} client disconnected.`)));
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
				this.fail(new Error(`${this.channelName} received an invalid JSON frame.`));
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
				this.fail(new Error(`${this.channelName} received an unexpected pipelined frame.`));
				this.socket.end();
				return;
			}
		}
	}

	private rejectOversizedFrame(): void {
		this.onProtocolRefusal("Request frame exceeded the 64 KiB byte limit.");
		writeFrame(this.socket, { ok: false, error: "Request frame is too large." });
		this.fail(new Error(`${this.channelName} frame exceeded its byte limit.`));
		this.socket.end();
	}

	private fail(error: Error): void {
		if (this.terminalError) return;
		this.terminalError = error;
		for (const waiter of this.waiting.splice(0)) waiter.reject(error);
	}
}
