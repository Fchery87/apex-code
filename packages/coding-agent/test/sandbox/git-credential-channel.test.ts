import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe.skipIf(process.platform === "win32")("git credential request validation", () => {
	interface Watched {
		path: string;
		allowedFor: string[];
		released: string[];
		filled: Array<{ host: string; protocol: string }>;
	}

	async function watchedProxy(): Promise<Watched> {
		const path = socketPath();
		const watched: Watched = { path, allowedFor: [], released: [], filled: [] };
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: (host) => {
				watched.allowedFor.push(host);
				return true;
			},
			requestRelease: async (host) => {
				watched.released.push(host);
				return true;
			},
			fillCredential: async (request) => {
				watched.filled.push({ host: request.host, protocol: request.protocol });
				return HOST_CREDENTIAL;
			},
		});
		closers.push(proxy.close);
		return watched;
	}

	// A field carrying a newline rewrites the request git's own protocol reads, so the
	// identity that was authorized is not the identity that gets served. Every one of
	// these must die before the reachability check even sees a host.
	const injections: Array<{ name: string; request: Record<string, unknown> }> = [
		{ name: "newline in protocol", request: { protocol: "https\nhost=other.invalid\n\n", host: "github.com" } },
		{ name: "newline in host", request: { protocol: "https", host: "github.com\nhost=other.invalid" } },
		{ name: "carriage return in protocol", request: { protocol: "https\rhost=other.invalid", host: "github.com" } },
		{ name: "carriage return in host", request: { protocol: "https", host: "github.com\rhost=other.invalid" } },
		{ name: "NUL in protocol", request: { protocol: "https\u0000", host: "github.com" } },
		{ name: "NUL in host", request: { protocol: "https", host: "github.com\u0000other.invalid" } },
		{ name: "space in host", request: { protocol: "https", host: "github.com other.invalid" } },
		{ name: "tab in protocol", request: { protocol: "ht\ttps", host: "github.com" } },
		{ name: "scheme with a separator", request: { protocol: "https://other.invalid", host: "github.com" } },
		{ name: "scheme starting with a digit", request: { protocol: "1https", host: "github.com" } },
		{ name: "empty scheme", request: { protocol: "", host: "github.com" } },
		{ name: "non-string protocol", request: { protocol: 7, host: "github.com" } },
		{ name: "non-string host", request: { protocol: "https", host: ["github.com"] } },
		{ name: "whitespace-only host", request: { protocol: "https", host: "   " } },
	];

	for (const injection of injections) {
		it(`refuses ${injection.name} before authorization`, async () => {
			const watched = await watchedProxy();

			const response = await ask(watched.path, { op: "get", ...injection.request });

			expect(response.ok).toBe(false);
			expect(watched.allowedFor).toEqual([]);
			expect(watched.released).toEqual([]);
			expect(watched.filled).toEqual([]);
			expect(JSON.stringify(response)).not.toContain("host-owned-token");
		});
	}

	it("records a refused request without echoing the injected bytes into the audit tail", async () => {
		const path = socketPath();
		const violationStore = new SandboxViolationStore();
		const proxy = await createGitCredentialProxy({
			socketPath: path,
			isHostAllowed: () => true,
			requestRelease: async () => true,
			fillCredential: async () => HOST_CREDENTIAL,
			violationStore,
		});
		closers.push(proxy.close);

		await ask(path, { op: "get", protocol: "https\nhost=other.invalid\n\n", host: "github.com" });

		const violations = violationStore.list();
		expect(violations).toHaveLength(1);
		expect(violations[0].detail).not.toContain("other.invalid");
		expect(violations[0].detail).not.toContain("\n");
	});

	it("keeps ssh working, because this is structural validation and not an https allowlist", async () => {
		const watched = await watchedProxy();

		await expect(ask(watched.path, { op: "get", protocol: "ssh", host: "github.com" })).resolves.toMatchObject({
			ok: true,
		});
		expect(watched.filled).toEqual([{ host: "github.com", protocol: "ssh" }]);
	});

	it("keeps a custom helper scheme working", async () => {
		const watched = await watchedProxy();

		await expect(
			ask(watched.path, { op: "get", protocol: "git+ssh", host: "code.internal.invalid" }),
		).resolves.toMatchObject({ ok: true });
		expect(watched.filled).toEqual([{ host: "code.internal.invalid", protocol: "git+ssh" }]);
	});

	it("authorizes and serves exactly one parsed identity, with the scheme lowercased", async () => {
		const watched = await watchedProxy();

		await expect(ask(watched.path, { op: "get", protocol: "HTTPS", host: "github.com" })).resolves.toMatchObject({
			ok: true,
		});
		expect(watched.allowedFor).toEqual(["github.com"]);
		expect(watched.released).toEqual(["github.com"]);
		expect(watched.filled).toEqual([{ host: "github.com", protocol: "https" }]);
	});
});

describe.skipIf(process.platform === "win32")("host git credential resolution is not run inside a repository", () => {
	interface HostileTree {
		repository: string;
		home: string;
		marker: string;
		environment: NodeJS.ProcessEnv;
	}

	function hostileTree(): HostileTree {
		const root = mkdtempSync(join(tmpdir(), "apex-git-cred-hostile-"));
		directories.push(root);
		const repository = join(root, "repo");
		const home = join(root, "home");
		const marker = join(root, "helper-ran");
		mkdirSync(repository);
		mkdirSync(home);
		// A repository the agent could have cloned. Its local config names a helper that is
		// a shell command; git runs it on whichever machine resolves the credential.
		expect(spawnSync("git", ["init", "-q", repository], { stdio: "ignore" }).status).toBe(0);
		expect(
			spawnSync("git", ["-C", repository, "config", "credential.helper", `!f() { touch "${marker}"; }; f`], {
				stdio: "ignore",
			}).status,
		).toBe(0);
		writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Ada\n");
		const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" };
		delete environment.GIT_CONFIG_GLOBAL;
		delete environment.GIT_DIR;
		delete environment.GIT_WORK_TREE;
		delete environment.GIT_INDEX_FILE;
		delete environment.GIT_CONFIG;
		return { repository, home, marker, environment };
	}

	it("never executes the credential helper of the repository the supervisor happens to stand in", async () => {
		const tree = hostileTree();
		const previous = process.cwd();
		process.chdir(tree.repository);
		try {
			await expect(
				fillHostGitCredential({ protocol: "https", host: "github.com" }, { environment: tree.environment }),
			).resolves.toBeUndefined();
		} finally {
			process.chdir(previous);
		}

		expect(existsSync(tree.marker)).toBe(false);
	});

	it("never executes a helper reached through GIT_DIR or GIT_CONFIG in the inherited environment", async () => {
		const tree = hostileTree();
		const injected: NodeJS.ProcessEnv = {
			...tree.environment,
			GIT_DIR: join(tree.repository, ".git"),
			GIT_WORK_TREE: tree.repository,
			GIT_CONFIG: join(tree.repository, ".git", "config"),
		};

		await expect(
			fillHostGitCredential({ protocol: "https", host: "github.com" }, { environment: injected }),
		).resolves.toBeUndefined();

		expect(existsSync(tree.marker)).toBe(false);
	});

	it("still resolves the host's global helper, so gh and the keychain keep working", async () => {
		const tree = hostileTree();
		writeFileSync(
			join(tree.home, ".gitconfig"),
			'[credential]\n\thelper = "!f() { test \\"$1\\" = get && printf \'username=ada\\npassword=from-host-store\\n\'; }; f"\n',
		);
		const previous = process.cwd();
		process.chdir(tree.repository);
		try {
			await expect(
				fillHostGitCredential({ protocol: "https", host: "github.com" }, { environment: tree.environment }),
			).resolves.toEqual({ username: "ada", password: "from-host-store" });
		} finally {
			process.chdir(previous);
		}

		expect(existsSync(tree.marker)).toBe(false);
	});

	it("refuses to serialize an injected identity, so git is never spawned for it", async () => {
		const tree = hostileTree();
		writeFileSync(
			join(tree.home, ".gitconfig"),
			`[credential]\n\thelper = "!f() { touch \\"${tree.marker}\\"; }; f"\n`,
		);

		await expect(
			fillHostGitCredential(
				{ protocol: "https\nhost=other.invalid", host: "github.com" },
				{ environment: tree.environment },
			),
		).resolves.toBeUndefined();
		await expect(
			fillHostGitCredential(
				{ protocol: "https", host: "github.com\nhost=other.invalid" },
				{ environment: tree.environment },
			),
		).resolves.toBeUndefined();

		expect(existsSync(tree.marker)).toBe(false);
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
