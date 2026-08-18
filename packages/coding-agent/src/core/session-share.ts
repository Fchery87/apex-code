import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SessionShareResult = { kind: "cancelled" } | { kind: "published"; gistUrl: string; gistId: string };

/** Why `/share` cannot run: the GitHub CLI is absent, or it has no usable credentials. */
export type ShareUnavailableReason = "missing" | "unauthenticated";

/**
 * Explain a failed `/share` preflight in terms the user can act on.
 *
 * `gh auth status` failing does not imply the user never logged in. The OS sandbox is
 * the normal startup path, and it cannot reach the host's gh credentials: `~/.config/gh`
 * sits under the tmpfs that replaces `/home`, `XDG_CONFIG_HOME` is redirected into the
 * sandbox state directory, and the token itself usually lives in a system keyring the
 * child cannot talk to. Telling that user to run `gh auth login` sends them after a
 * problem they do not have, so lead with the split-across-the-boundary workflow — which
 * works because exporting inside the workspace is allowed — and keep the plain login
 * hint for a genuinely logged-out host.
 */
export function formatShareUnavailableMessage(reason: ShareUnavailableReason): string {
	if (reason === "missing") {
		return "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/";
	}
	return [
		"GitHub CLI has no credentials in this session.",
		"Apex Code normally runs inside the OS sandbox, which cannot see the host's gh login:",
		"run /export here, then 'gh gist create --public=false <file>' outside the sandbox.",
		"If this session is not sandboxed, run 'gh auth login' first.",
	].join(" ");
}

export interface PublishSessionShareOptions {
	confirm: () => Promise<boolean>;
	exportToHtml: (path: string) => Promise<void>;
	publishGist: (path: string) => Promise<string>;
	temporaryRoot?: string;
}

/** Confirm, export, and publish one session without exposing a predictable temporary path. */
export async function publishSessionShare(options: PublishSessionShareOptions): Promise<SessionShareResult> {
	if (!(await options.confirm())) return { kind: "cancelled" };
	const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "apex-code-share-"));
	const exportPath = join(directory, "session.html");
	try {
		await options.exportToHtml(exportPath);
		const gistUrl = (await options.publishGist(exportPath)).trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) throw new Error("Failed to parse gist ID from gh output");
		return { kind: "published", gistUrl, gistId };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
