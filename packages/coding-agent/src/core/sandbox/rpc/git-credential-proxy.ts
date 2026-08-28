import { chmodSync, existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import type { SandboxViolationStore } from "../violations.ts";
import { FrameReader, isRequestObject, writeFrame } from "./framing.ts";

const MAX_CONNECTIONS = 32;

export interface GitCredentialRequest {
	readonly protocol: string;
	readonly host: string;
}

export interface GitCredential {
	readonly username: string;
	readonly password: string;
}

export interface GitCredentialProxy {
	close(): Promise<void>;
}

/**
 * Serve git credentials to the sandboxed child without ever putting one inside it.
 *
 * ADR 0015 keeps credentials host-owned and hands the child a read-only projection. A git
 * credential cannot be projected the same way: it is not one file with a stable shape, it
 * is whatever the host's own helper produces per host. So the credential stays on the host
 * and only the answer to one question crosses, for one host, once it has been released.
 *
 * Two gates, and the first is the one that matters most.
 *
 * The host must be reachable by this session. git only asks for a credential after a
 * server challenged it, so in the ordinary flow the host was already allowed or approved
 * at the network layer. A request for a host the session cannot reach is therefore not git
 * doing its job; it is something that went looking for a token. Refusing it costs nothing
 * real and removes the case where this channel is more useful to an attacker than to git.
 *
 * The human must release it. Per ADR 0023 that decision is the supervisor's, because this
 * socket has no peer authentication -- every descendant in the child's namespace can reach
 * it, which is precisely the code the boundary exists to contain. Without a releaser the
 * channel refuses outright, so a headless session cannot hand out a credential at all.
 *
 * A release covers one host for the session. It is never persisted and never widened to a
 * second host, which is what keeps an approval for a push from also releasing a token to
 * whatever else the session later contacts.
 */
export function createGitCredentialProxy(options: {
	socketPath: string;
	/** Whether this session may reach the host at all. */
	isHostAllowed: (host: string) => boolean;
	/** Ask a human to release the host's credential. Absent means refuse without asking. */
	requestRelease?: (host: string) => Promise<boolean>;
	/** Resolve the credential on the host, using the host's own configuration. */
	fillCredential: (request: GitCredentialRequest) => Promise<GitCredential | undefined>;
	violationStore?: SandboxViolationStore;
}): Promise<GitCredentialProxy> {
	/** Hosts released this session. Never persisted, never widened. */
	const released = new Set<string>();
	const pending = new Map<string, Promise<boolean>>();

	function audit(host: string, detail: string): void {
		options.violationStore?.add({
			kind: "network",
			command: `git credential ${host}`,
			detail,
			timestamp: new Date(),
		});
	}

	async function release(host: string): Promise<boolean> {
		if (released.has(host)) return true;
		if (!options.requestRelease) return false;
		const inFlight = pending.get(host);
		if (inFlight) return inFlight;
		const question = (async () => {
			try {
				const approved = await (options.requestRelease as (h: string) => Promise<boolean>)(host);
				if (approved) released.add(host);
				return approved;
			} catch {
				return false;
			} finally {
				pending.delete(host);
			}
		})();
		pending.set(host, question);
		return question;
	}

	async function answer(request: unknown): Promise<object> {
		if (!isRequestObject(request)) return { ok: false, error: "Malformed request." };
		if (request.op !== "get") {
			// Only `get` crosses. `store` and `erase` would let the child rewrite the host's
			// credential store, which ADR 0015 keeps as an explicit host operation.
			return { ok: false, error: "Only credential reads are served over this channel." };
		}
		const host = typeof request.host === "string" ? request.host : "";
		const protocol = typeof request.protocol === "string" ? request.protocol : "https";
		if (!host) return { ok: false, error: "Request named no host." };

		if (!options.isHostAllowed(host)) {
			audit(host, `Refused a credential for ${host}, which this session may not reach.`);
			return { ok: false, error: "Host is not reachable by this session." };
		}
		if (!(await release(host))) {
			audit(host, `Credential for ${host} was not released.`);
			return { ok: false, error: "Credential was not released." };
		}
		const credential = await options.fillCredential({ host, protocol });
		if (!credential) {
			audit(host, `The host credential store had nothing for ${host}.`);
			return { ok: false, error: "No credential is configured for that host." };
		}
		return { ok: true, username: credential.username, password: credential.password };
	}

	return new Promise((resolve, reject) => {
		// A prior launch that never closed leaves a stale socket file that listen() refuses
		// to bind over, exactly as the network proxy handles.
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
			const reader = new FrameReader(socket, "Git credential channel", (detail) =>
				audit("(protocol)", `Refused: ${detail}`),
			);
			void (async () => {
				try {
					const response = await answer(await reader.next());
					writeFrame(socket, response);
				} catch {
					// A disconnected or malformed client is the reader's business; there is
					// nothing to answer and nothing to record beyond what it already did.
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
				// The containing directory is already 0700; the mode here is defence in depth.
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
