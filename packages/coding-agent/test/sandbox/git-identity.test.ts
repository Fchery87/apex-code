import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectedGitConfig, resolveHostGitIdentity } from "../../src/core/sandbox/git-identity.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

/** A host home carrying exactly the global config the test wants git itself to resolve. */
function hostHome(gitconfig: string): NodeJS.ProcessEnv {
	const home = temporaryDirectory("apex-git-identity-home-");
	writeFileSync(join(home, ".gitconfig"), gitconfig);
	// XDG_CONFIG_HOME would otherwise let the running account's own config answer, and an
	// inherited GIT_CONFIG_GLOBAL would redirect --global away from this fixture entirely.
	const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
	delete environment.GIT_CONFIG_GLOBAL;
	return environment;
}

function hasGit(): boolean {
	return spawnSync("git", ["--version"], { stdio: "ignore", timeout: 1_000 }).status === 0;
}

describe.skipIf(!hasGit())("host git identity resolution", () => {
	it("resolves both keys from the host's own global configuration", () => {
		const environment = hostHome("[user]\n\tname = Ada Lovelace\n\temail = ada@example.invalid\n");

		expect(resolveHostGitIdentity({ environment })).toEqual({
			name: "Ada Lovelace",
			email: "ada@example.invalid",
		});
	});

	it("resolves nothing when the host has no identity at all", () => {
		const environment = hostHome("[core]\n\tpager = less\n");

		expect(resolveHostGitIdentity({ environment })).toBeUndefined();
	});

	it("resolves nothing when the host has only one of the two keys", () => {
		// A name without an email still fails to author a commit, so a partial identity is
		// not worth projecting -- it would replace one confusing error with another.
		const environment = hostHome("[user]\n\tname = Ada Lovelace\n");

		expect(resolveHostGitIdentity({ environment })).toBeUndefined();
	});

	it("does not consult repository scope, so a workspace cannot influence what is projected", () => {
		const repository = temporaryDirectory("apex-git-identity-repo-");
		spawnSync("git", ["init", "--quiet"], { cwd: repository });
		spawnSync("git", ["config", "user.name", "Repository Author"], { cwd: repository });
		spawnSync("git", ["config", "user.email", "repo@example.invalid"], { cwd: repository });
		const environment = hostHome("[core]\n\tpager = less\n");

		const resolved = resolveHostGitIdentity({ environment, cwd: repository });

		expect(resolved).toBeUndefined();
	});
});

describe.skipIf(!hasGit())("projected git configuration", () => {
	it("writes only the two identity keys into a private supervisor-owned directory", () => {
		const projected = createProjectedGitConfig({ name: "Ada Lovelace", email: "ada@example.invalid" });
		directories.push(projected.directory);

		const contents = readFileSync(projected.path, "utf8");
		expect(contents).toContain("Ada Lovelace");
		expect(contents).toContain("ada@example.invalid");
		// POSIX modes only. Windows has no OS sandbox at all (ADR 0005), so there is nothing
		// here to keep private from; the content assertions above still matter everywhere.
		if (process.platform !== "win32") {
			expect(statSync(projected.directory).mode & 0o777).toBe(0o700);
		}
	});

	it("carries nothing the host config held beyond the identity", () => {
		// The reason this synthesizes rather than copies. A real ~/.gitconfig can carry a
		// credential helper invocation or an insteadOf rule holding a token, and projecting
		// the file wholesale would hand both to the child.
		const environment = hostHome(
			[
				"[user]",
				"\tname = Ada Lovelace",
				"\temail = ada@example.invalid",
				"[credential]",
				"\thelper = !echo password=hunter2",
				'[url "https://token@github.com/"]',
				"\tinsteadOf = https://github.com/",
			].join("\n"),
		);

		const identity = resolveHostGitIdentity({ environment });
		expect(identity).toBeDefined();
		const projected = createProjectedGitConfig(identity as { name: string; email: string });
		directories.push(projected.directory);

		const contents = readFileSync(projected.path, "utf8");
		expect(contents).not.toContain("credential");
		expect(contents).not.toContain("insteadOf");
		expect(contents).not.toContain("hunter2");
	});

	it("produces a file git itself reads back as the global identity", () => {
		const projected = createProjectedGitConfig({ name: "Ada Lovelace", email: "ada@example.invalid" });
		directories.push(projected.directory);
		const consumer = temporaryDirectory("apex-git-identity-consumer-");
		mkdirSync(join(consumer, "sub"), { recursive: true });

		const read = spawnSync("git", ["config", "--get", "user.email"], {
			cwd: consumer,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: projected.path, HOME: consumer },
		});

		expect(read.stdout.trim()).toBe("ada@example.invalid");
	});
});
