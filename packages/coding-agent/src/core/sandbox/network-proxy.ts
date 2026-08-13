import { existsSync, unlinkSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { SandboxViolationStore } from "./violations.ts";

export interface SandboxNetworkProxy {
	readonly server: http.Server;
	/** Set only in TCP-listen mode (`tcpHost`); the ephemeral port the proxy bound. */
	readonly port?: number;
	close(): Promise<void>;
}

export function createSandboxNetworkProxy(
	options: {
		allowedHosts: readonly string[];
		violationStore?: SandboxViolationStore;
	} & ({ socketPath: string; tcpHost?: undefined } | { socketPath?: undefined; tcpHost: string }),
): Promise<SandboxNetworkProxy> {
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

			const isAllowed =
				options.allowedHosts.includes(hostname) || options.allowedHosts.includes(`${hostname}:${port}`);
			if (!isAllowed) {
				clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
				clientSocket.destroy();
				options.violationStore?.add({
					kind: "network",
					command: `CONNECT ${hostname}:${port}`,
					detail: `Host ${hostname} refused by allowlist policy.`,
					timestamp: new Date(),
				});
				return;
			}

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
				close: () => new Promise((r) => server.close(() => r())),
			});
		});
	});
}
