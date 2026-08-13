import { existsSync, unlinkSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { SandboxViolationStore } from "./violations.ts";

export interface SandboxNetworkProxy {
	readonly server: http.Server;
	close(): Promise<void>;
}

export function createSandboxNetworkProxy(options: {
	socketPath: string;
	allowedHosts: readonly string[];
	violationStore?: SandboxViolationStore;
}): Promise<SandboxNetworkProxy> {
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

			const isAllowed = options.allowedHosts.includes(hostname) || options.allowedHosts.includes(`${hostname}:${port}`);
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
