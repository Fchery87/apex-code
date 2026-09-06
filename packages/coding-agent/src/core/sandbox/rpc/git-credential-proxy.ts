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

/** A request that survived validation, or the reason it did not. */
export type GitCredentialRequestParse =
	| { readonly ok: true; readonly request: GitCredentialRequest }
	| { readonly ok: false; readonly error: string; readonly audit: string };

/**
 * git's credential protocol is `key=value` lines terminated by a blank line, so any byte
 * that can end a line or a field can rewrite the request downstream of this point. A
 * `protocol` of `https\nhost=other.invalid\n\n` is authorized as one identity and served as
 * another; the same is true of a carriage return, a NUL, or a bare space.
 */
const LINE_OR_FIELD_BREAKING = /[\s\u0000-\u001f\u007f-\u009f]/u;

/**
 * Structural, not an allowlist. Hardcoding `https` would refuse `ssh` and every custom
 * scheme a host helper answers for, which is a working feature rather than an attack. What
 * is refused is anything that is not a scheme: RFC 3986's shape, lowercased first so that
 * the released identity and the served one cannot differ by case.
 */
const SCHEME_SHAPE = /^[a-z][a-z0-9+.-]*$/;

/** Bounds, so a frame that is within the reader's byte limit is still not an essay. */
const MAX_HOST_LENGTH = 255;
const MAX_PROTOCOL_LENGTH = 32;

/**
 * Parse one credential request into the single structured identity everything downstream
 * uses.
 *
 * The caller authorizes, releases, and serializes *this* value and never the raw fields,
 * because the defect this closes is precisely that the string checked against the release
 * was not the string handed to git.
 */
export function parseGitCredentialRequest(request: Record<string, unknown>): GitCredentialRequestParse {
	const rawProtocol = request.protocol;
	// git's own helper always sends one; an absent field means "whatever git defaults to",
	// and https is what this channel has always assumed. A present non-string is a client
	// that is not git.
	if (rawProtocol !== undefined && typeof rawProtocol !== "string") {
		return { ok: false, error: "Request protocol was not a string.", audit: "protocol field was not a string" };
	}
	if (typeof request.host !== "string") {
		return { ok: false, error: "Request named no host.", audit: "host field was absent or not a string" };
	}

	const protocol = (rawProtocol ?? "https").toLowerCase();
	const host = request.host;
	if (!host) return { ok: false, error: "Request named no host.", audit: "host field was empty" };
	if (host.length > MAX_HOST_LENGTH) {
		return { ok: false, error: "Request host is too long.", audit: "host field exceeded its length bound" };
	}
	if (LINE_OR_FIELD_BREAKING.test(host)) {
		return {
			ok: false,
			error: "Request host contains a control or whitespace character.",
			audit: "host field carried a control or whitespace character",
		};
	}
	if (protocol.length > MAX_PROTOCOL_LENGTH) {
		return { ok: false, error: "Request protocol is too long.", audit: "protocol field exceeded its length bound" };
	}
	if (!SCHEME_SHAPE.test(protocol)) {
		return {
			ok: false,
			error: "Request protocol is not a scheme.",
			audit: "protocol field was not a scheme",
		};
	}
	return { ok: true, request: { protocol, host } };
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
		const parsed = parseGitCredentialRequest(request);
		if (!parsed.ok) {
			// The refused bytes are deliberately not echoed. This tail is read by a human and
			// rendered in a terminal, and the whole point of the refused field is that it
			// carries line breaks and control characters.
			audit("(protocol)", `Refused a credential request whose ${parsed.audit}.`);
			return { ok: false, error: parsed.error };
		}
		const { host, protocol } = parsed.request;

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
