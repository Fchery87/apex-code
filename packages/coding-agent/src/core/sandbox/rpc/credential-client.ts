/** Child-side credential store for sandboxed sessions. */

import * as net from "node:net";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../../config.ts";
import { ReadOnlyAuthStorage } from "../../auth-storage.ts";

export const CREDENTIAL_CHANNEL_SOCKET_ENV = "APEX_CREDENTIAL_PROXY_PATH";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface CurrentFrame {
	readonly type?: unknown;
	readonly credential?: unknown;
}

interface ResultFrame {
	readonly ok?: unknown;
	readonly credential?: unknown;
	readonly error?: unknown;
}

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const credential = value as Record<string, unknown>;
	if (credential.type === "api_key") {
		return (
			(credential.key === undefined || typeof credential.key === "string") &&
			(credential.env === undefined ||
				(typeof credential.env === "object" &&
					credential.env !== null &&
					!Array.isArray(credential.env) &&
					Object.values(credential.env).every((entry) => typeof entry === "string")))
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

function parseCurrentCredential(frame: CurrentFrame): Credential | undefined {
	if (frame.credential === undefined) return undefined;
	if (!isCredential(frame.credential))
		throw new Error("The credential channel returned an invalid current credential.");
	return frame.credential;
}

export class SandboxAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private readonly socketPath: string;
	private readOnly: ReadOnlyAuthStorage;

	constructor(options: { socketPath: string; authPath?: string }) {
		this.socketPath = options.socketPath;
		this.authPath = options.authPath ?? getAuthPath();
		this.readOnly = new ReadOnlyAuthStorage(this.authPath, { resolveCommands: true });
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.readOnly.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.readOnly.list(options);
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const result = await this.transaction(
			{ action: "modify", providerId },
			async (frame, send) => {
				if (frame.type !== "current") throw new Error("The credential channel returned an unexpected response.");
				const current = parseCurrentCredential(frame);
				let next: Credential | undefined;
				try {
					next = await fn(current);
				} catch (error) {
					send({ action: "abort" });
					throw error;
				}
				send(next === undefined ? { action: "no_change" } : { action: "commit", credential: next });
			},
			options,
		);
		this.invalidateReadView();
		return result;
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.transaction({ action: "delete", providerId }, undefined, options);
		this.invalidateReadView();
	}

	private invalidateReadView(): void {
		this.readOnly = new ReadOnlyAuthStorage(this.authPath, { resolveCommands: true });
	}

	private transaction(
		initial: object,
		onCurrent: ((frame: CurrentFrame, send: (frame: object) => void) => Promise<void>) | undefined,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const client = net.connect(this.socketPath);
			let settled = false;
			let buffer = Buffer.alloc(0);
			let handling = Promise.resolve();
			const timeout = setTimeout(
				() => finish(new Error("Timed out waiting for the credential channel to answer.")),
				REQUEST_TIMEOUT_MS,
			);

			const finish = (error: Error | undefined, result?: Credential): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				options?.signal?.removeEventListener("abort", onAbort);
				client.destroy();
				if (error) reject(error);
				else resolve(result);
			};
			const onAbort = (): void => finish(new Error("Operation aborted."));
			const send = (frame: object): void => {
				if (!client.destroyed) client.write(`${JSON.stringify(frame)}\n`);
			};
			const handleFrame = async (frame: unknown): Promise<void> => {
				if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
					finish(new Error("The credential channel returned a malformed response."));
					return;
				}
				const response = frame as CurrentFrame & ResultFrame;
				if (response.type === "current") {
					if (!onCurrent) throw new Error("The credential channel returned an unexpected current value.");
					await onCurrent(response, send);
					return;
				}
				if (response.ok === true) {
					if (response.credential !== undefined && !isCredential(response.credential)) {
						throw new Error("The credential channel returned an invalid credential.");
					}
					finish(undefined, response.credential as Credential | undefined);
					return;
				}
				finish(
					new Error(
						typeof response.error === "string" ? response.error : "The credential channel refused the mutation.",
					),
				);
			};

			options?.signal?.addEventListener("abort", onAbort, { once: true });
			client.on("connect", () => send(initial));
			client.on("data", (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				if (buffer.length > MAX_RESPONSE_BYTES && buffer.indexOf(0x0a) < 0) {
					finish(new Error("The credential channel response is too large."));
					return;
				}
				let newline = buffer.indexOf(0x0a);
				while (newline >= 0) {
					if (newline > MAX_RESPONSE_BYTES) {
						finish(new Error("The credential channel response is too large."));
						return;
					}
					const raw = buffer.subarray(0, newline);
					buffer = buffer.subarray(newline + 1);
					let frame: unknown;
					try {
						frame = JSON.parse(raw.toString("utf8")) as unknown;
					} catch {
						finish(new Error("The credential channel returned a malformed response."));
						return;
					}
					handling = handling
						.then(() => handleFrame(frame))
						.catch((error: unknown) => {
							finish(error instanceof Error ? error : new Error(String(error)));
						});
					newline = buffer.indexOf(0x0a);
				}
				if (buffer.length > MAX_RESPONSE_BYTES) {
					finish(new Error("The credential channel response is too large."));
				}
			});
			client.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EACCES" || error.code === "ENOENT" || error.code === "ECONNREFUSED") {
					finish(
						new Error(
							`The sandbox credential channel is unavailable (${error.code}); this session cannot modify credentials.`,
						),
					);
					return;
				}
				finish(new Error(`The sandbox credential channel failed: ${error.message}`));
			});
		});
	}
}

export function createSandboxCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore | undefined {
	const socketPath = env[CREDENTIAL_CHANNEL_SOCKET_ENV];
	if (!socketPath) return undefined;
	return new SandboxAuthStorage({ socketPath });
}
