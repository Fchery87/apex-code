import { existsSync, unlinkSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { SandboxViolationStore } from "./violations.ts";

export interface SandboxNetworkProxy {
	readonly server: http.Server;
	/** Set only in TCP-listen mode (`tcpHost`); the ephemeral port the proxy bound. */
	readonly port?: number;
	/**
	 * Whether this session may reach `hostname` on any port, by configuration or by a
	 * grant the human made this session.
	 *
	 * Exposed so the git credential channel can ask the one component that actually knows,
	 * rather than keeping a second copy of the allowlist that would drift from this one the
	 * first time a host is approved at runtime.
	 */
	isHostReachable(hostname: string): boolean;
	close(): Promise<void>;
}

export function createSandboxNetworkProxy(
	options: {
		allowedHosts: readonly string[];
		violationStore?: SandboxViolationStore;
		/**
		 * Ask a human whether to permit one refused host for the rest of this session.
		 *
		 * Supplied by the supervisor and never by the child: per ADR 0023, an approval
		 * asserted from inside the boundary would be indistinguishable from one forged by
		 * the code the boundary exists to contain. Absent means deny without asking, which
		 * is exactly today's behaviour and what ADR 0005 requires of headless, print,
		 * JSON, and RPC modes.
		 */
		requestApproval?: (hostname: string, port: number) => Promise<boolean>;
	} & ({ socketPath: string; tcpHost?: undefined } | { socketPath?: undefined; tcpHost: string }),
): Promise<SandboxNetworkProxy> {
	/** Hosts a human permitted this session. Never persisted; a durable entry is a settings edit. */
	const granted = new Set<string>();
	/**
	 * Approvals currently awaiting an answer, keyed the same way a grant is.
	 *
	 * A real prompt takes as long as a human takes to read it, and a refused host usually
	 * arrives as several near-simultaneous connections. Without this, each one raises its
	 * own prompt for the same question.
	 */
	const pending = new Map<string, Promise<boolean>>();

	function isHostReachable(hostname: string): boolean {
		if (options.allowedHosts.some((entry) => entry === hostname || entry.startsWith(`${hostname}:`))) return true;
		for (const grant of granted) {
			if (grant === hostname || grant.startsWith(`${hostname}:`)) return true;
		}
		return false;
	}

	function isAllowed(hostname: string, port: number): boolean {
		return (
			options.allowedHosts.includes(hostname) ||
			options.allowedHosts.includes(`${hostname}:${port}`) ||
			granted.has(`${hostname}:${port}`)
		);
	}

	async function approve(hostname: string, port: number): Promise<boolean> {
		const key = `${hostname}:${port}`;
		if (granted.has(key)) return true;
		const inFlight = pending.get(key);
		if (inFlight) return inFlight;
		// Declining is deliberately not remembered. A second attempt asks again, because a
		// cached "no" would be indistinguishable to the user from the boundary having
		// silently stopped asking.
		const question = (async () => {
			try {
				const approved = await (options.requestApproval as (h: string, p: number) => Promise<boolean>)(
					hostname,
					port,
				);
				if (approved) granted.add(key);
				return approved;
			} catch {
				return false;
			} finally {
				pending.delete(key);
			}
		})();
		pending.set(key, question);
		return question;
	}

	return new Promise((resolve, reject) => {
		const server = http.createServer((_req, res) => {
			res.writeHead(405, { "Content-Type": "text/plain" });
			res.end("Method Not Allowed\n");
		});

		server.on("connect", (req, clientSocket, head) => {
			const match = req.url?.match(/^([^:]+):(\d+)$/);
			if (!match) {
				clientSocket.destroy();
				return;
			}

			const hostname = match[1];
			const port = Number.parseInt(match[2], 10);

			function refuse(): void {
				if (!clientSocket.destroyed) {
					clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
					clientSocket.destroy();
				}
				options.violationStore?.add({
					kind: "network",
					command: `CONNECT ${hostname}:${port}`,
					detail: `Host ${hostname} refused by allowlist policy.`,
					timestamp: new Date(),
				});
			}

			if (!isAllowed(hostname, port)) {
				if (!options.requestApproval) {
					refuse();
					return;
				}
				// The client is left waiting on its CONNECT while the human reads the
				// prompt, which is what makes an approved host resume the original request
				// instead of surfacing as a failure the caller has to retry.
				void approve(hostname, port).then((approved) => {
					if (approved) tunnel();
					else refuse();
				});
				return;
			}
			tunnel();

			function tunnel(): void {
				if (clientSocket.destroyed) return;
				const serverSocket = net.connect(Number(port) || 443, hostname, () => {
					clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					serverSocket.write(head);
					serverSocket.pipe(clientSocket);
					clientSocket.pipe(serverSocket);
				});

				serverSocket.on("error", () => {
					if (!clientSocket.destroyed) {
						clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
						clientSocket.destroy();
					}
				});

				clientSocket.on("error", () => {
					serverSocket.destroy();
				});
			}
		});

		server.on("error", reject);

		if (options.tcpHost !== undefined) {
			// macOS's Seatbelt can permit a specific localhost port directly, so the
			// proxy listens on loopback TCP there instead of a Unix domain socket --
			// no in-child relay process is needed the way Linux's `--unshare-net`
			// requires one.
			server.listen(0, options.tcpHost, () => {
				server.off("error", reject);
				const address = server.address();
				const port = typeof address === "object" && address !== null ? address.port : undefined;
				resolve({
					server,
					port,
					isHostReachable,
					close: () => new Promise((r) => server.close(() => r())),
				});
			});
			return;
		}

		// A prior sandboxed launch that never called close() (a crash, a SIGKILL)
		// leaves a stale socket file behind; Node's listen() refuses to bind over
		// one even though nothing is listening on it.
		if (existsSync(options.socketPath)) {
			unlinkSync(options.socketPath);
		}

		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve({
				server,
				isHostReachable,
				close: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}
