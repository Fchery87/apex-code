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
export function createHostApprover(options: {
	handoff: TerminalHandoff;
	input?: NodeJS.ReadStream;
	output?: NodeJS.WriteStream;
}): ((hostname: string, port: number) => Promise<boolean>) | undefined {
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

	return (hostname: string, port: number): Promise<boolean> =>
		options.handoff.borrowTerminal(async () => {
			output.write(
				`\nThe sandboxed session asked to reach ${hostname}:${port}, which is not on the network allowlist.\n` +
					`Allow it for this session only? [y/N] `,
			);
			const answer = (await readAnswer()).trim().toLowerCase();
			const approved = answer === "y" || answer === "yes";
			output.write(
				approved
					? `Allowed ${hostname}:${port} for this session. Add it to "network.allowedHosts" in your global settings to make it permanent.\n\n`
					: `Refused ${hostname}:${port}.\n\n`,
			);
			return approved;
		});
}
