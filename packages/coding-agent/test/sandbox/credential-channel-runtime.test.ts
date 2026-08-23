import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { createCredentialProxy } from "../../src/core/sandbox/rpc/credential-proxy.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

/**
 * The child-side wiring of the credential channel: a session runtime built while the
 * supervisor's channel is advertised must write credentials through it, so `/login`
 * works inside a sandboxed session (spec: 2026-08-22-supervisor-mediated-credential-
 * writes). No OS sandbox is involved -- the routing decision under test is which store
 * the runtime was handed, proven by the audit entry only the channel's proxy writes.
 */

const directories: string[] = [];
let services: Awaited<ReturnType<typeof createAgentSessionServices>> | undefined;

afterEach(async () => {
	delete process.env.APEX_CODE_AUTH_PATH;
	delete process.env.APEX_CREDENTIAL_PROXY_PATH;
	await services?.close();
	services = undefined;
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

// Windows has no unix domain socket at a filesystem path; net.listen() there needs a
// named pipe, so the channel and every test that binds it are POSIX-only (ADR 0005).
describe.skipIf(process.platform === "win32")("agent session services credential channel wiring", () => {
	it("routes a runtime login through the advertised channel store", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apex-channel-runtime-"));
		directories.push(cwd);
		const authPath = join(cwd, "auth.json");
		writeFileSync(authPath, "{}", { mode: 0o600 });
		const socketPath = join(cwd, "channel.sock");
		const violations = new SandboxViolationStore();
		const proxy = await createCredentialProxy({ authPath, violationStore: violations, socketPath });

		process.env.APEX_CODE_AUTH_PATH = authPath;
		process.env.APEX_CREDENTIAL_PROXY_PATH = socketPath;

		try {
			services = await createAgentSessionServices({ cwd, agentDir: cwd });
			await services.modelRuntime.login("anthropic", "api_key", {
				prompt: async () => "sk-ant-literal-test-key",
				notify: async () => {},
			});
		} finally {
			await proxy.close();
		}

		const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
		expect(stored.anthropic?.key).toBe("sk-ant-literal-test-key");
		// The write reached the host file through the channel, not by opening it
		// directly: only the proxy writes audit entries.
		expect(violations.list().map((violation) => violation.command)).toContain("credential-write anthropic");
	});

	it("builds the ordinary host store when no channel is advertised", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apex-channel-runtime-"));
		directories.push(cwd);
		const authPath = join(cwd, "auth.json");
		writeFileSync(authPath, "{}", { mode: 0o600 });

		process.env.APEX_CODE_AUTH_PATH = authPath;

		services = await createAgentSessionServices({ cwd, agentDir: cwd });
		await services.modelRuntime.login("anthropic", "api_key", {
			prompt: async () => "sk-ant-direct-test-key",
			notify: async () => {},
		});

		const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
		expect(stored.anthropic?.key).toBe("sk-ant-direct-test-key");
	});
});
