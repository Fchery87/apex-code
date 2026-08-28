import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { supervisorTempDirectory } from "../supervisor-temp.ts";
import type { GitCredential, GitCredentialRequest } from "./git-credential-proxy.ts";

/** Env var naming the child-side socket the helper talks to. */
export const GIT_CREDENTIAL_SOCKET_VARIABLE = "APEX_GIT_CREDENTIAL_PATH";

/**
 * The credential helper git runs inside the sandbox.
 *
 * `.cjs` for the same reason the network relay is: a plain `.js` under a workspace whose
 * package.json declares `"type": "module"` is parsed as ESM and dies on `require`.
 *
 * It answers `get` and nothing else. `store` and `erase` exit silently and successfully,
 * which is what tells git the credential was handled and stops it falling through to
 * another helper. Writing is deliberately not served: ADR 0015 keeps credential mutation
 * an explicit host operation, and a channel that let the child rewrite the host's store
 * would be a way out of the boundary rather than a way to work inside it.
 *
 * Any failure exits 0 having printed nothing, which git reads as "this helper has no
 * credential" and handles normally. Exiting non-zero would surface as a git error that
 * looks like a repository problem rather than a refused release.
 */
const HELPER_SOURCE = `
const net = require("node:net");

const operation = process.argv[2];
if (operation !== "get") process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
});
process.stdin.on("end", () => {
	const request = {};
	for (const line of input.split("\\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) request[line.slice(0, separator)] = line.slice(separator + 1).trim();
	}
	const socketPath = process.env.${GIT_CREDENTIAL_SOCKET_VARIABLE};
	if (!socketPath || !request.host) process.exit(0);

	const socket = net.connect(socketPath);
	let buffer = "";
	const giveUp = () => {
		socket.destroy();
		process.exit(0);
	};
	socket.on("connect", () => {
		socket.write(JSON.stringify({ op: "get", protocol: request.protocol || "https", host: request.host }) + "\\n");
	});
	socket.on("data", (chunk) => {
		buffer += chunk.toString();
		const newline = buffer.indexOf("\\n");
		if (newline < 0) return;
		let response;
		try {
			response = JSON.parse(buffer.slice(0, newline));
		} catch {
			giveUp();
			return;
		}
		if (response && response.ok) {
			process.stdout.write("username=" + response.username + "\\n");
			process.stdout.write("password=" + response.password + "\\n");
		}
		socket.destroy();
		process.exit(0);
	});
	socket.on("error", giveUp);
});
`.trim();

/** AF_UNIX `sun_path` is 108 bytes on Linux, including the terminating NUL. */
const SUN_PATH_LIMIT = 108;

export interface GitCredentialChannelPaths {
	readonly hostSocketDirectory: string;
	readonly hostSocketPath: string;
	readonly childSocketPath: string;
}

/**
 * Where the git credential socket lives on each side, mirroring the credential channel's
 * own resolution. TMPDIR is deliberately not honoured: it can point inside the workspace
 * on macOS, which the sandbox may write. The child-side path sits under `/home` on Linux
 * because the `--tmpfs /home` is the only writable mount when bwrap creates the mountpoint.
 */
export function resolveGitCredentialChannelPaths(): GitCredentialChannelPaths {
	const hostSocketDirectory = mkdtempSync(join(supervisorTempDirectory(), `apex-gitcred-${process.pid}-`), {
		encoding: "utf8",
	});
	chmodSync(hostSocketDirectory, 0o700);
	const hostSocketPath = join(hostSocketDirectory, "channel.sock");
	if (Buffer.byteLength(hostSocketPath) + 1 > SUN_PATH_LIMIT) {
		throw new Error("Git credential channel path exceeds the Unix socket path limit.");
	}
	const childSocketPath = process.platform === "linux" ? "/home/apex-git-credential-channel.sock" : hostSocketPath;
	return { hostSocketDirectory, hostSocketPath, childSocketPath };
}

/**
 * Where the helper lives, derived rather than passed.
 *
 * The supervisor writes `credential.helper` into the projected git config before the
 * platform backend exists, and the backend writes the file itself. Deriving both from the
 * state directory is what keeps the config from naming a path nothing ever created.
 */
export function gitCredentialHelperPath(stateDirectory: string): string {
	return join(stateDirectory, "git-credential-apex.cjs");
}

/** The `credential.helper` value naming that helper, run under the supervisor's own node. */
export function gitCredentialHelperCommand(stateDirectory: string, nodePath = process.execPath): string {
	return `!"${nodePath}" "${gitCredentialHelperPath(stateDirectory)}"`;
}

/** Write the helper into a directory the child can read, returning its path. */
export function writeGitCredentialHelper(directory: string): string {
	const path = gitCredentialHelperPath(directory);
	writeFileSync(path, HELPER_SOURCE);
	return path;
}

/**
 * Resolve a credential on the host, through the host's own git configuration.
 *
 * `git credential fill` rather than reading any particular store, because the answer may
 * come from `gh`'s helper, libsecret, the macOS keychain, or a plain file, and only git
 * knows which of those this host is configured to ask. Reimplementing that resolution
 * would be a second, quietly diverging copy of it.
 */
export async function fillHostGitCredential(
	request: GitCredentialRequest,
	options?: { environment?: NodeJS.ProcessEnv; cwd?: string },
): Promise<GitCredential | undefined> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const child = spawn("git", ["credential", "fill"], {
			cwd: options?.cwd,
			env: options?.environment ?? process.env,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => {
			if (code !== 0) {
				resolve(undefined);
				return;
			}
			const fields = new Map<string, string>();
			for (const line of stdout.split("\n")) {
				const separator = line.indexOf("=");
				if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
			}
			const username = fields.get("username");
			const password = fields.get("password");
			resolve(username && password ? { username, password } : undefined);
		});
		child.stdin.end(`protocol=${request.protocol}\nhost=${request.host}\n\n`);
	});
}
