/**
 * Child-side credential store for sandboxed sessions.
 *
 * Spec: `docs/specs/2026-08-22-supervisor-mediated-credential-writes.md`. Reads stay
 * exactly where they are today -- the read-only `auth.json` projection mounted by ADR
 * 0015 -- so no credential read path changes on either side of the boundary. Writes and
 * deletes travel the supervisor-owned unix socket advertised as
 * `APEX_CREDENTIAL_PROXY_PATH`, where the content constraint in `credential-proxy.ts`
 * applies before anything reaches the host file.
 */

import * as net from "node:net";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getAuthPath } from "../../../config.ts";
import { ReadOnlyAuthStorage } from "../../auth-storage.ts";

/** Environment variable carrying the child-side channel socket path. */
export const CREDENTIAL_CHANNEL_SOCKET_ENV = "APEX_CREDENTIAL_PROXY_PATH";

/** Timeout for one channel round trip; `/login` must not hang forever on a dead socket. */
const REQUEST_TIMEOUT_MS = 15_000;

export class SandboxAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private readonly socketPath: string;
	private readOnly: ReadOnlyAuthStorage;

	constructor(options: { socketPath: string; authPath?: string }) {
		this.socketPath = options.socketPath;
		this.authPath = options.authPath ?? getAuthPath();
		this.readOnly = new ReadOnlyAuthStorage(this.authPath);
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
		const current = await this.read(providerId, options);
		const next = await fn(current);
		// Returning undefined means "no change", matching AuthStorage.modify's contract.
		if (next === undefined) return current;
		await this.request({ action: "write", providerId, credential: next }, options);
		this.invalidateReadView();
		return next;
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		await this.request({ action: "delete", providerId }, options);
		this.invalidateReadView();
	}

	/**
	 * The read-only view caches the file it loaded. A credential the channel just
	 * wrote must be visible to the next read -- `/login` has to work in the same
	 * session that saved it -- so an accepted mutation retires the cached view.
	 */
	private invalidateReadView(): void {
		this.readOnly = new ReadOnlyAuthStorage(this.authPath);
	}

	private request(payload: unknown, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				finish(new Error("Timed out waiting for the credential channel to answer."));
			}, REQUEST_TIMEOUT_MS);
			const client = net.connect(this.socketPath);
			let settled = false;
			let buffer = "";

			const finish = (error: Error | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				options?.signal?.removeEventListener("abort", onAbort);
				client.destroy();
				if (error) reject(error);
				else resolve();
			};
			const onAbort = () => {
				finish(new Error("Operation aborted."));
			};

			options?.signal?.addEventListener("abort", onAbort, { once: true });
			client.setEncoding("utf8");
			client.on("connect", () => {
				client.write(`${JSON.stringify(payload)}\n`);
			});
			client.on("data", (chunk: string) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				let response: { ok?: boolean; error?: string };
				try {
					response = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; error?: string };
				} catch {
					finish(new Error("The credential channel returned a malformed response."));
					return;
				}
				finish(response.ok ? undefined : new Error(response.error ?? "The credential channel refused the write."));
			});
			client.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EACCES" || error.code === "ENOENT" || error.code === "ECONNREFUSED") {
					finish(
						new Error(
							`The sandbox credential channel is unavailable (${error.code ?? error.message}); ` +
								"this session cannot modify credentials.",
						),
					);
					return;
				}
				finish(new Error(`The sandbox credential channel failed: ${error.message}`));
			});
		});
	}
}

/**
 * The credential store a sandboxed session should use, or undefined outside one.
 *
 * The supervisor advertises the channel only when it opened one, so the mere absence of
 * the variable means "not sandboxed" and the caller keeps its default store. An empty
 * string is treated as absent: an unset-looking variable must never produce a store that
 * throws on first write.
 */
export function createSandboxCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore | undefined {
	const socketPath = env[CREDENTIAL_CHANNEL_SOCKET_ENV];
	if (!socketPath) return undefined;
	return new SandboxAuthStorage({ socketPath });
}
