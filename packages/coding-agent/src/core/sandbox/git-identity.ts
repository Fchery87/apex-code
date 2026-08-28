import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HostGitIdentity {
	readonly name: string;
	readonly email: string;
}

export interface ProjectedGitConfig {
	readonly directory: string;
	readonly path: string;
}

/** Long enough for a cold `git` on a slow disk, short enough not to stall every launch. */
const RESOLUTION_TIMEOUT_MILLISECONDS = 2_000;

/**
 * Read the host's git identity before the sandbox exists to hide it.
 *
 * `--global` rather than a plain lookup, because the scope flag is what excludes the
 * workspace's own `.git/config` by construction rather than by choosing a lucky working
 * directory. A repository must not be able to decide what the supervisor projects, the
 * same rule ADR 0016 applies to the network allowlist. Repository scope still works
 * normally inside the child: the workspace is bind-mounted read-write, so git reads
 * `.git/config` there itself and it wins over this projection, exactly as it would on the
 * host.
 *
 * System scope (`/etc/gitconfig`) is deliberately not consulted. A machine-wide commit
 * identity is not a real configuration, and a second `spawnSync` to find one would cost
 * every launch what it saves nobody.
 *
 * Returns undefined unless both keys are present. A name without an email still fails to
 * author a commit, so projecting half an identity would replace one confusing error with
 * another.
 */
export function resolveHostGitIdentity(options?: {
	/** Injectable only for tests; production uses the supervisor's own environment. */
	environment?: NodeJS.ProcessEnv;
	/**
	 * Injectable only for tests, so one can prove repository scope stays excluded even
	 * when the lookup runs from inside a repository.
	 */
	cwd?: string;
}): HostGitIdentity | undefined {
	const result = spawnSync("git", ["config", "--global", "--get-regexp", "^user\\.(name|email)$"], {
		cwd: options?.cwd,
		encoding: "utf8",
		env: options?.environment ?? process.env,
		timeout: RESOLUTION_TIMEOUT_MILLISECONDS,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return undefined;

	let name: string | undefined;
	let email: string | undefined;
	for (const line of result.stdout.split("\n")) {
		const separator = line.indexOf(" ");
		if (separator < 0) continue;
		const value = line.slice(separator + 1).trim();
		if (value.length === 0) continue;
		if (line.slice(0, separator) === "user.name") name = value;
		if (line.slice(0, separator) === "user.email") email = value;
	}
	return name && email ? { name, email } : undefined;
}

/** Escape a value for git's config syntax, which reads a quoted string with backslash escapes. */
function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write a two-key config the child can be pointed at through `GIT_CONFIG_GLOBAL`.
 *
 * Synthesized rather than copied. A real `~/.gitconfig` can carry a `credential.helper`
 * that runs a command, or an `insteadOf` rule rewriting a remote to one carrying a token;
 * projecting the host file would hand both to the child along with the name we wanted.
 * Building the file from a resolved identity means it cannot contain anything else.
 *
 * The directory is its own, not shared with the credential projection, and `0700` for the
 * same reason `resolveCredentialChannelPaths` uses one. TMPDIR is deliberately not
 * honoured: it can point inside the workspace on macOS, which the sandbox may write.
 */
export function createProjectedGitConfig(identity: HostGitIdentity): ProjectedGitConfig {
	const directory = mkdtempSync(`/tmp/apex-git-${process.pid}-`, { encoding: "utf8" });
	chmodSync(directory, 0o700);
	const path = join(directory, "config");
	writeFileSync(path, `[user]\n\tname = ${quote(identity.name)}\n\temail = ${quote(identity.email)}\n`, {
		mode: 0o600,
	});
	return { directory, path };
}
