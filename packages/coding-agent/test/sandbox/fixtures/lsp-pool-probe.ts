/**
 * Runs inside a real sandboxed launch (test/sandbox/lsp-spawn-environment.test.ts,
 * test/sandbox/lsp-network.test.ts) to prove that a language-server child spawned
 * through the real `LspPool` -- not a stand-in that merely resembles it -- inherits
 * the sandbox's private environment and is bound by the same egress boundary as any
 * other sandboxed child. One script covers every mode so the `LspPool` wiring is not
 * duplicated per assertion.
 *
 * `LspPool`/`LspClient` never accept a configured per-server environment override
 * (LSP.3's spec: "LSP settings never accept arbitrary environment overrides"), so
 * this script constructs `LspPool` exactly as production does: no `env` option, which
 * means the server child inherits `process.env` of whatever process is already
 * running -- here, this script's own process, already running inside the sandbox.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LspPool } from "../../../src/core/lsp/pool.ts";
import { resolveLspRegistry } from "../../../src/core/lsp/registry.ts";

const STUB_SERVER = fileURLToPath(new URL("../../fixtures/lsp-stub-server.mjs", import.meta.url));

/** A CONNECT request through the proxy at $HTTP_PROXY -- identical in shape to
 * `test/sandbox/network-allowlist.test.ts`'s `connectProbeScript`, duplicated here
 * (not imported) because it must be embedded as a string run via `-e` in a plain,
 * non-TypeScript child. */
function connectProbeSource(port: number): string {
	return `
		const net = require("node:net");
		const url = new URL(process.env.HTTP_PROXY);
		const c = net.connect(Number(url.port), url.hostname, () => {
			c.write("CONNECT 127.0.0.1:${port} HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\n\\r\\n");
		});
		c.on("data", (d) => process.exit(d.toString().includes("200") ? 0 : 1));
		c.on("error", () => process.exit(1));
		c.on("close", () => process.exit(1));
	`;
}

/** Configures one real server (the shared stub) and has it report its own
 * `process.env` to `reportPath` before the handshake continues -- proving what the
 * spawned server child actually saw, not what this script saw. */
async function reportEnv(reportPath: string): Promise<void> {
	process.env.APEX_LSP_STUB_REPORT_ENV_PATH = reportPath;
	const registry = resolveLspRegistry(
		{
			probe: {
				command: process.execPath,
				args: [STUB_SERVER],
				languages: [{ languageId: "text", extensions: [".txt"] }],
			},
		},
		{ workspace: process.cwd() },
	);
	const pool = new LspPool(registry);
	await pool.start();
	await pool.dispose();
}

/** Configures the connect-probe itself as the "server" command, so the egress
 * attempt happens on the exact child `LspPool.start()` spawns. The probe never
 * speaks JSON-RPC, so `initialize` always fails one way or another once the CONNECT
 * settles; the assertion this mode exists for is the sandbox's own network-violation
 * record (inspected by the host test via `dependencies.stderr`), not this process's
 * exit code -- so the rejection is expected and swallowed. */
async function egressRefused(port: number): Promise<void> {
	const registry = resolveLspRegistry(
		{
			probe: {
				command: process.execPath,
				args: ["-e", connectProbeSource(port)],
				languages: [{ languageId: "text", extensions: [".txt"] }],
				initializationTimeoutMs: 2_000,
			},
		},
		{ workspace: process.cwd() },
	);
	const pool = new LspPool(registry);
	try {
		await pool.start();
	} catch {
		// Expected -- see the doc comment above.
	} finally {
		await pool.dispose();
	}
}

/** Runs a full, realistic pool lifecycle against the well-behaved shared stub --
 * start, a demand `acquire()` for a nested selection, then dispose -- and only after
 * that completes, attempts a CONNECT to a host that was never in `allowedHosts`. The
 * process exit code carries that final probe's outcome, so the host test can assert
 * refusal exactly as it would for any other sandboxed child; the point is that this
 * still refuses *after* a real language server ran, not merely before one existed. */
async function lifecycleThenEgress(port: number): Promise<void> {
	const workspace = process.cwd();
	const registry = resolveLspRegistry(
		{
			real: {
				command: process.execPath,
				args: [STUB_SERVER],
				languages: [{ languageId: "text", extensions: [".txt"] }],
			},
		},
		{ workspace },
	);
	const pool = new LspPool(registry);
	await pool.start();
	const probePath = `${workspace}/probe.txt`;
	writeFileSync(probePath, "");
	const connection = await pool.acquire(probePath);
	if (!connection) throw new Error("Expected the well-behaved stub to be selected for probe.txt.");
	await pool.dispose();

	const result = spawnSync(process.execPath, ["-e", connectProbeSource(port)], { stdio: "inherit" });
	process.exitCode = result.status ?? 1;
}

const [, , mode, arg] = process.argv;
switch (mode) {
	case "env":
		await reportEnv(arg);
		break;
	case "egress-refused":
		await egressRefused(Number(arg));
		break;
	case "lifecycle-then-egress":
		await lifecycleThenEgress(Number(arg));
		break;
	default:
		throw new Error(`Unknown probe mode: ${mode}`);
}
