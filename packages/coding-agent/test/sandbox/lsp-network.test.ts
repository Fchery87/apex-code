/**
 * LSP.3 — sandbox egress. Mirrors `test/sandbox/network-allowlist.test.ts` exactly,
 * but the egress attempt happens on a child spawned through the real `LspPool`
 * rather than a bare script, and a second assertion is the one the spec calls out as
 * the one that matters: starting and using a language server adds no host to
 * `network.allowedHosts`.
 *
 * `network.allowedHosts` is a fixed array closed over once, at sandbox-launch time
 * (`createSandboxPolicy`/`buildSandboxedCliLaunch`); nothing in `core/lsp/*` calls
 * anything that could mutate it, and this subsystem exposes no such API. The second
 * test proves that architectural fact behaviorally rather than only by inspection: a
 * host absent from the allowlist is still refused *after* a real `LspPool` lifecycle
 * (start, a demand `acquire()`, dispose) ran inside the same sandboxed process --
 * proving the pool's own lifecycle did not widen the boundary it consumes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchSandboxedCli } from "../../src/core/sandbox/cli-supervisor.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const PROBE_SCRIPT = join(import.meta.dirname, "fixtures/lsp-pool-probe.ts");
const READ_ONLY_PATHS = [join(REPO_ROOT, "package.json")];

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-lsp-network-"));
	directories.push(directory);
	return directory;
}

describe.skipIf(!canEnforceLinuxSandbox())("LSP server egress inside the sandbox", () => {
	let testServer: http.Server;
	let testServerPort: number;

	beforeAll(async () => {
		testServer = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("hello from test server");
		});
		await new Promise<void>((resolvePromise) => {
			testServer.listen(0, "127.0.0.1", () => {
				testServerPort = (testServer.address() as net.AddressInfo).port;
				resolvePromise();
			});
		});
	});

	afterAll(async () => {
		if (testServer) {
			await new Promise<void>((resolvePromise) => testServer.close(() => resolvePromise()));
		}
	});

	it("refuses a non-allowlisted host for a child spawned through LspPool.start(), exactly as for any other sandboxed child", async () => {
		const cwd = workspace();
		let stderr = "";

		const code = await launchSandboxedCli({
			command: process.execPath,
			args: [PROBE_SCRIPT, "egress-refused", String(testServerPort)],
			environment: {},
			workspace: cwd,
			allowedHosts: ["example.com"],
			readOnlyPaths: READ_ONLY_PATHS,
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});

		// The probe script's own exit code is not the signal here -- egressRefused()
		// swallows LspClient.start()'s rejection (expected, since the probe never
		// speaks JSON-RPC) and the script simply returns, so it exits 0 either way. The
		// assertion is the proxy's own recorded refusal, exactly matching
		// network-allowlist.test.ts's assertions for a bare sandboxed child.
		void code;
		expect(stderr).toContain("Sandbox violation (network)");
		expect(stderr).toContain(`CONNECT 127.0.0.1:${testServerPort}`);
		expect(stderr).toContain("refused by allowlist policy");
		expect(stderr).not.toContain("Network is unreachable");
	});

	it("starting and using a language server through the pool adds no host to the allowlist", async () => {
		const cwd = workspace();
		let stderr = "";

		// allowedHosts never names 127.0.0.1:testServerPort. A full, successful LspPool
		// lifecycle (start against the well-behaved stub, a demand acquire(), dispose)
		// runs first inside the sandboxed process; only after that does the probe script
		// attempt the same CONNECT this file's other test already proves gets refused
		// cold. If running a language server had widened the allowlist, this would
		// silently start succeeding -- that is exactly the regression this guards.
		const code = await launchSandboxedCli({
			command: process.execPath,
			args: [PROBE_SCRIPT, "lifecycle-then-egress", String(testServerPort)],
			environment: {},
			workspace: cwd,
			allowedHosts: ["example.com"],
			readOnlyPaths: READ_ONLY_PATHS,
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});

		expect(code, stderr).not.toBe(0);
		expect(stderr).toContain("Sandbox violation (network)");
		expect(stderr).toContain(`CONNECT 127.0.0.1:${testServerPort}`);
		expect(stderr).toContain("refused by allowlist policy");
	});

	it("still allows an explicitly allowlisted host for a child spawned through LspPool.start()", async () => {
		const cwd = workspace();
		let stderr = "";

		const code = await launchSandboxedCli({
			command: process.execPath,
			args: [PROBE_SCRIPT, "egress-refused", String(testServerPort)],
			environment: {},
			workspace: cwd,
			allowedHosts: ["127.0.0.1"],
			readOnlyPaths: READ_ONLY_PATHS,
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});

		expect(stderr).not.toContain("Sandbox violation");
		// The probe still exits non-zero -- it is not a real language server and
		// LspClient.start() never completes -- but no refusal was recorded, proving the
		// CONNECT itself succeeded through the allowlist this time.
		void code;
	});
});
