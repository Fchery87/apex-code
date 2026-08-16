import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SessionShareResult = { kind: "cancelled" } | { kind: "published"; gistUrl: string; gistId: string };

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
