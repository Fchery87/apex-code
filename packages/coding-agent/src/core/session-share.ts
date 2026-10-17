import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * Credential-shaped strings that must not leave the machine in a shared transcript. Each
 * pattern is anchored by a provider's fixed prefix and a minimum length, so ordinary prose
 * such as "the sk- prefix" or a version number is left alone.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/sk-ant-[A-Za-z0-9_-]{20,}/g,
	/sk-[A-Za-z0-9_-]{20,}/g,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
	/github_pat_[A-Za-z0-9_]{22,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/AIza[0-9A-Za-z_-]{35}/g,
	/xox[abposr]-[A-Za-z0-9-]{10,}/g,
];

/** Replace each credential-shaped string with `[REDACTED]` and count the replacements. */
export function redactSecrets(text: string): { text: string; count: number } {
	let count = 0;
	let redacted = text;
	for (const pattern of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, () => {
			count++;
			return "[REDACTED]";
		});
	}
	return { text: redacted, count };
}

export interface PublishSessionShareOptions {
	/**
	 * Asked after the export is redacted, with the number of values replaced, so the user
	 * decides with the real count in front of them. Returns false to publish nothing.
	 */
	confirm: (redactions: number) => Promise<boolean>;
	exportToHtml: (path: string) => Promise<void>;
	publishGist: (path: string) => Promise<string>;
	temporaryRoot?: string;
}

/** Export, redact, confirm, and publish one session without exposing a predictable temporary path. */
export async function publishSessionShare(options: PublishSessionShareOptions): Promise<SessionShareResult> {
	const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "apex-code-share-"));
	const exportPath = join(directory, "session.html");
	try {
		await options.exportToHtml(exportPath);
		const redacted = redactSecrets(await readFile(exportPath, "utf8"));
		await writeFile(exportPath, redacted.text, { mode: 0o600 });
		if (!(await options.confirm(redacted.count))) return { kind: "cancelled" };
		const gistUrl = (await options.publishGist(exportPath)).trim();
		const gistId = gistUrl.split("/").pop();
		if (!gistId) throw new Error("Failed to parse gist ID from gh output");
		return { kind: "published", gistUrl, gistId };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
