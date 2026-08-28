/**
 * The explicit opt-out from OS containment.
 *
 * ADR 0005 shipped without one on purpose, and its 2026-08-28 amendment records why that
 * is now a flag rather than an absence: the delegation work removed the reasons people
 * were reaching for an escape hatch, so the hatch can exist without becoming the default
 * route around a boundary that could not otherwise be worked with.
 *
 * Two rules keep it honest. It is spelled out in full on the command line, never inferred
 * from settings, so no repository and no saved configuration can turn the boundary off.
 * And it always announces itself, because a session that silently ran unconfined is
 * indistinguishable afterwards from one that did not.
 */

const BANNER = [
	"",
	"  ! OS sandbox disabled for this session (--sandbox danger-full-access).",
	"",
	"    Tool calls and every process they spawn run with your full account authority:",
	"    your home directory, your credentials, and unrestricted network access.",
	"    The permission gate still applies. It is not a containment boundary.",
	"",
].join("\n");

export function writeFullAccessBanner(stderr: { write(message: string): boolean }): void {
	stderr.write(`${BANNER}\n`);
}

/**
 * Confirm the opt-out interactively, or accept it unprompted where no human could answer.
 *
 * A non-interactive session is the case the flag legitimately exists for -- CI that is
 * already externally sandboxed -- and there is nobody there to type. Prompting anyway
 * would hang the run rather than protect anything, so the banner carries the weight.
 */
export function confirmFullAccess(options: {
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}): Promise<boolean> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	if (!input.isTTY || !output.isTTY) return Promise.resolve(true);

	output.write("Run this session with no OS sandbox? [y/N] ");
	return new Promise((resolve) => {
		let buffer = "";
		const finish = (value: string) => {
			input.off("data", onData);
			input.off("error", onError);
			input.pause();
			const answer = value.trim().toLowerCase();
			output.write("\n");
			resolve(answer === "y" || answer === "yes");
		};
		const onData = (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline >= 0) finish(buffer.slice(0, newline));
		};
		// Anything unreadable declines, because an unanswerable prompt must not be the way
		// containment gets switched off.
		const onError = () => finish("");
		input.on("data", onData);
		input.on("error", onError);
		input.resume();
	});
}
