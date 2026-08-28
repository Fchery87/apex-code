import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fillHostGitCredential,
	GIT_CREDENTIAL_SOCKET_VARIABLE,
	writeGitCredentialHelper,
} from "../../src/core/sandbox/rpc/git-credential-helper.ts";
import { createGitCredentialProxy } from "../../src/core/sandbox/rpc/git-credential-proxy.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function socketPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-git-cred-"));
	directories.push(directory);
	return join(directory, "channel.sock");
}

function ask(path: string, request: unknown): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(path, () => socket.write(`${JSON.stringify(request)}\n`));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				socket.destroy();
				resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			}
		});
		socket.on("error", reject);
	});
}

const HOST_CREDENTIAL = { username: "fchery87", password: "host-owned-token" };

describe.skipIf(process.platform === "win32")("sandbox git credential channel", () => {
	it("answers a request for an allowed host the human released", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "get", protocol: "https", host: "github.com" })).resolves.toMatchObject({
			ok: true,
			username: "fchery87",
			password: "host-owned-token",
		});
	});

	it("refuses a host the session cannot even reach, without consulting the host store", async () => {
		// git only asks for a credential after the server challenged it, so the host was
		// already reachable. A request for an unreachable host is therefore not git's
		// ordinary flow, and answering it would hand a token to something that went
		// looking for one.
		const path = socketPath();
		let filled = 0;
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: (host) => host === "github.com",
			requestRelease: async () => true,
			fillCredential: async () => {
				filled += 1;
				return HOST_CREDENTIAL;
			},
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "get", protocol: "https", host: "evil.invalid" })).resolves.toMatchObject({
			ok: false,
		});
		expect(filled).toBe(0);
	});

	it("refuses when the human declines to release the credential", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => false,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		const response = await ask(path, { op: "get", protocol: "https", host: "github.com" });
		expect(response.ok).toBe(false);
		expect(JSON.stringify(response)).not.toContain("host-owned-token");
	});

	it("refuses without asking when no releaser is configured", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "get", protocol: "https", host: "github.com" })).resolves.toMatchObject({
			ok: false,
		});
	});

	it("asks the human once per host, not once per git invocation", async () => {
		const path = socketPath();
		let asks = 0;
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => {
				asks += 1;
				return true;
			},
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		await ask(path, { op: "get", protocol: "https", host: "github.com" });
		await ask(path, { op: "get", protocol: "https", host: "github.com" });

		expect(asks).toBe(1);
	});

	it("scopes the release to one host, so a second host asks again", async () => {
		const path = socketPath();
		const asked: string[] = [];
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async (host) => {
				asked.push(host);
				return host === "github.com";
			},
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "get", protocol: "https", host: "github.com" })).resolves.toMatchObject({
			ok: true,
		});
		await expect(ask(path, { op: "get", protocol: "https", host: "gitlab.com" })).resolves.toMatchObject({
			ok: false,
		});
		expect(asked).toEqual(["github.com", "gitlab.com"]);
	});

	it("passes the requested host to the host credential store verbatim", async () => {
		const path = socketPath();
		const seen: Array<{ host: string; protocol: string }> = [];
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async (request) => {
				seen.push({ host: request.host, protocol: request.protocol });
				return HOST_CREDENTIAL;
			},
		});
		closers.push(proxy.close);

		await ask(path, { op: "get", protocol: "https", host: "github.com" });

		expect(seen).toEqual([{ host: "github.com", protocol: "https" }]);
	});

	it("refuses when the host store has no credential, rather than returning an empty one", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => undefined,
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "get", protocol: "https", host: "github.com" })).resolves.toMatchObject({
			ok: false,
		});
	});

	it("audits a refusal without putting the credential in the tail", async () => {
		const path = socketPath();
		const violationStore = new SandboxViolationStore();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => false,
			requestRelease: async () => true,
			fillCredential: async () => HOST_CREDENTIAL,
			violationStore,
		});
		closers.push(proxy.close);

		await ask(path, { op: "get", protocol: "https", host: "evil.invalid" });

		const violations = violationStore.list();
		expect(violations).toHaveLength(1);
		expect(violations[0].detail).toContain("evil.invalid");
		expect(JSON.stringify(violations)).not.toContain("host-owned-token");
	});

	it("refuses an unknown operation rather than treating it as a get", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "exfiltrate", protocol: "https", host: "github.com" })).resolves.toMatchObject({
			ok: false,
		});
	});

	it("refuses a frame with no host at all", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);

		await expect(ask(path, { op: "get", protocol: "https" })).resolves.toMatchObject({ ok: false });
	});
});

describe.skipIf(process.platform === "win32")("git credential helper, run as git runs it", () => {
	function runHelper(
		helperPath: string,
		operation: string,
		stdin: string,
		environment: NodeJS.ProcessEnv,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [helperPath, operation], {
				env: { ...process.env, ...environment },
				stdio: ["pipe", "pipe", "ignore"],
			});
			let stdout = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.on("error", reject);
			child.on("close", () => resolve(stdout));
			child.stdin.end(stdin);
		});
	}

	it("prints the credential git asked for when the supervisor released it", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);
		const helperPath = writeGitCredentialHelper(dirname(path));

		const output = await runHelper(helperPath, "get", "protocol=https\nhost=github.com\n\n", {
			[GIT_CREDENTIAL_SOCKET_VARIABLE]: path,
		});

		expect(output).toContain("username=fchery87");
		expect(output).toContain("password=host-owned-token");
	});

	it("prints nothing and still exits cleanly when the release is refused", async () => {
		const path = socketPath();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => false,
			fillCredential: async () => HOST_CREDENTIAL,
		});
		closers.push(proxy.close);
		const helperPath = writeGitCredentialHelper(dirname(path));

		const output = await runHelper(helperPath, "get", "protocol=https\nhost=github.com\n\n", {
			[GIT_CREDENTIAL_SOCKET_VARIABLE]: path,
		});

		expect(output).toBe("");
	});

	it("prints nothing when there is no channel to ask, rather than failing git", async () => {
		const path = socketPath();
		const helperPath = writeGitCredentialHelper(dirname(path));

		const output = await runHelper(helperPath, "get", "protocol=https\nhost=github.com\n\n", {
			[GIT_CREDENTIAL_SOCKET_VARIABLE]: "",
		});

		expect(output).toBe("");
	});

	it("serves no write operation, so the child cannot rewrite the host store", async () => {
		const path = socketPath();
		let filled = 0;
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => {
				filled += 1;
				return HOST_CREDENTIAL;
			},
		});
		closers.push(proxy.close);
		const helperPath = writeGitCredentialHelper(dirname(path));

		for (const operation of ["store", "erase"]) {
			const output = await runHelper(
				helperPath,
				operation,
				"protocol=https\nhost=github.com\nusername=x\npassword=y\n\n",
				{ [GIT_CREDENTIAL_SOCKET_VARIABLE]: path },
			);
			expect(output).toBe("");
		}
		expect(filled).toBe(0);
	});
});

describe("host git credential resolution", () => {
	it("returns whatever the host's own configured helper answers", async () => {
		const home = mkdtempSync(join(tmpdir(), "apex-git-cred-home-"));
		directories.push(home);
		// A real helper in a real gitconfig, resolved by real git. Reimplementing which
		// store this host uses is the thing fillHostGitCredential exists to avoid.
		writeFileSync(
			join(home, ".gitconfig"),
			'[credential]\n\thelper = "!f() { test \\"$1\\" = get && printf \'username=ada\\npassword=from-host-store\\n\'; }; f"\n',
		);
		const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		delete environment.GIT_CONFIG_GLOBAL;

		await expect(fillHostGitCredential({ protocol: "https", host: "github.com" }, { environment })).resolves.toEqual({
			username: "ada",
			password: "from-host-store",
		});
	});

	it("resolves nothing when the host has no credential for that host", async () => {
		const home = mkdtempSync(join(tmpdir(), "apex-git-cred-empty-home-"));
		directories.push(home);
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Ada\n");
		const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" };
		delete environment.GIT_CONFIG_GLOBAL;

		await expect(
			fillHostGitCredential({ protocol: "https", host: "nothing.invalid" }, { environment }),
		).resolves.toBeUndefined();
	});
});
