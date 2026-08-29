/**
 * Git Checkpoint Extension
 *
 * Offers to restore code state when /fork rewinds the conversation to an earlier entry.
 *
 * Capture is not here. Setting `"checkpoints": { "enabled": true }` makes the harness
 * snapshot the worktree at every turn, keyed to the session entry, into
 * `refs/apex-code/checkpoints/<sessionId>/<entryId>`. This extension only asks the
 * question, because whether to prompt is a UI decision and the harness stays headless.
 *
 * The engine is resolved from the workspace rather than handed over, because the
 * registry is git itself. That is also why a checkpoint survives a restart.
 */

import { createGitCheckpoints, type ExtensionAPI, type GitCheckpoints } from "apex-code";

export default function (pi: ExtensionAPI) {
	let engine: Promise<GitCheckpoints | undefined> | undefined;

	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;

		engine ??= createGitCheckpoints(ctx.cwd, ctx.sessionManager.getSessionId());
		const checkpoint = await (await engine)?.lookup(event.entryId);
		if (!checkpoint) return;

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);
		if (!choice?.startsWith("Yes")) return;

		const previous = await (await engine)?.restore(checkpoint);
		ctx.ui.notify(
			previous
				? `Code restored. Previous state kept at ${previous.commit.slice(0, 8)}.`
				: "Checkpoint restore failed; code is unchanged.",
			previous ? "info" : "error",
		);
	});
}
