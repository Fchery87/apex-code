import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SessionShareResult = { kind: "cancelled" } | { kind: "published"; gistUrl: string; gistId: string };

/** Why `/share` cannot run: the GitHub CLI is absent, or it has no usable credentials. */
export type ShareUnavailableReason = "missing" | "unauthenticated";

/**
 * Explain a failed `/share` preflight in terms the user can act on.
 *
 * A session now runs with the account's own permissions and reads the host's real
 * `~/.config/gh`, so a failing `gh auth status` means what it says. This message used to
 * lead with a split-across-the-boundary export workflow and steer users away from
 * `gh auth login`, because under the OS boundary that login genuinely could not help.
 * ADR 0032 removed the boundary, which makes logging in the correct and sufficient fix.
 * Exporting is still offered, for a host that is deliberately logged out.
 */
export function formatShareUnavailableMessage(reason: ShareUnavailableReason): string {
	if (reason === "missing") {
		return "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/";
	}
	return [
		"GitHub CLI has no credentials.",
		"Run 'gh auth login', then try /share again.",
		"To publish without logging in, run /export and then 'gh gist create --public=false <file>'.",
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
