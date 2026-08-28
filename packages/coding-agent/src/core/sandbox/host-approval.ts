import type { TerminalHandoff } from "./terminal-handoff.ts";

/**
 * The supervisor's own approval prompt for one refused host.
 *
 * ADR 0023 puts the decision here rather than in the child. An approval asserted from
 * inside the boundary is indistinguishable, at the supervisor, from one forged by a
 * postinstall script or a git hook -- the code the boundary exists to contain -- so the
 * human's answer is read by the side that owns the decision, on a terminal borrowed back
 * from the child for the duration.
 *
 * Returning undefined when there is no terminal is the mechanism, not a fallback. The
 * proxy's own deny-without-asking path then runs unchanged, so ADR 0005's headless, print,
 * JSON, and RPC behaviour holds by construction rather than by a mode check that a later
 * change could forget to make.
 */
export interface TerminalPromptOptions {
	handoff: TerminalHandoff;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}

/**
 * Build a yes/no prompt the supervisor owns, or nothing at all when there is no terminal.
 *
 * Both sandbox escalations ask the same shape of question and must fail closed the same
 * way, so they share one implementation. Returning undefined rather than a
 * function-that-says-no is deliberate: the caller's own refuse path then runs untouched,
 * which is how ADR 0005's headless behaviour stays correct without a mode check.
 */
function createTerminalPrompt(
	options: TerminalPromptOptions,
	compose: (subject: string) => { question: string; granted: string; refused: string },
): ((subject: string) => Promise<boolean>) | undefined {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	if (!input.isTTY || !output.isTTY) return undefined;

	function readAnswer(): Promise<string> {
		return new Promise((resolve) => {
			let buffer = "";
			const finish = (value: string) => {
				input.off("data", onData);
				input.off("error", onError);
				input.off("end", onEnd);
				// The child had stdin in raw mode and takes it back on resume, so the
				// supervisor leaves the stream paused rather than owning it past the answer.
				input.pause();
				resolve(value);
			};
			const onData = (chunk: Buffer | string) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline >= 0) finish(buffer.slice(0, newline));
			};
			// Anything unreadable declines. Treating an unanswerable prompt as consent would
			// hand the grant to whatever broke the terminal.
			const onError = () => finish("");
			const onEnd = () => finish(buffer);
			input.on("data", onData);
			input.on("error", onError);
			input.on("end", onEnd);
			input.resume();
		});
	}

	return (subject: string): Promise<boolean> =>
		options.handoff.borrowTerminal(async () => {
			const text = compose(subject);
			output.write(`\n${text.question}`);
			const answer = (await readAnswer()).trim().toLowerCase();
			const approved = answer === "y" || answer === "yes";
			output.write(`${approved ? text.granted : text.refused}\n\n`);
			return approved;
		});
}

/** Approve one refused host for the rest of the session. */
export function createHostApprover(
	options: TerminalPromptOptions,
): ((hostname: string, port: number) => Promise<boolean>) | undefined {
	const prompt = createTerminalPrompt(options, (subject) => ({
		question:
			`The sandboxed session asked to reach ${subject}, which is not on the network allowlist.\n` +
			`Allow it for this session only? [y/N] `,
		granted: `Allowed ${subject} for this session. Add it to "network.allowedHosts" in your global settings to make it permanent.`,
		refused: `Refused ${subject}.`,
	}));
	if (!prompt) return undefined;
	return (hostname: string, port: number) => prompt(`${hostname}:${port}`);
}

/**
 * Release the host's own git credential for one host, for the rest of the session.
 *
 * Separate from the host approval above even though both are yes/no, because they are
 * different grants and conflating them would let approving a push also release a token to
 * everything else the session later contacts.
 */
export function createCredentialReleaser(
	options: TerminalPromptOptions,
): ((host: string) => Promise<boolean>) | undefined {
	return createTerminalPrompt(options, (subject) => ({
		question:
			`The sandboxed session asked for your git credential for ${subject}.\n` +
			`It is read from your host credential store and never written into the workspace.\n` +
			`Release it for this session only? [y/N] `,
		granted: `Released the ${subject} credential for this session.`,
		refused: `Refused the ${subject} credential.`,
	}));
}
