import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createHostApprover } from "../../src/core/sandbox/host-approval.ts";
import type { TerminalHandoff } from "../../src/core/sandbox/terminal-handoff.ts";

/** A handoff that records its use without touching a real filesystem or terminal. */
function recordingHandoff(events: string[]): TerminalHandoff {
	return {
		async borrowTerminal<T>(prompt: () => Promise<T>): Promise<T> {
			events.push("borrow");
			try {
				return await prompt();
			} finally {
				events.push("return");
			}
		},
		stop() {},
	};
}

function terminal(isTTY: boolean) {
	const input = new PassThrough() as unknown as NodeJS.ReadStream;
	const output = new PassThrough() as unknown as NodeJS.WriteStream;
	let written = "";
	output.on("data", (chunk: Buffer) => {
		written += chunk.toString();
	});
	(input as unknown as { isTTY: boolean }).isTTY = isTTY;
	(output as unknown as { isTTY: boolean }).isTTY = isTTY;
	(input as unknown as { setRawMode: () => void }).setRawMode = () => {};
	return { input, output, written: () => written };
}

describe("sandbox host approval", () => {
	it("offers no approver without a terminal, so headless denies by construction", () => {
		const { input, output } = terminal(false);

		const approver = createHostApprover({ handoff: recordingHandoff([]), input, output });

		// Not "an approver that says no" -- no approver at all, so the proxy's own
		// deny-without-asking path runs and ADR 0005's headless behaviour cannot be
		// reintroduced by a mode check someone forgets.
		expect(approver).toBeUndefined();
	});

	it("names the exact host, the port, and the setting that would make it permanent", async () => {
		const { input, output, written } = terminal(true);
		const approver = createHostApprover({ handoff: recordingHandoff([]), input, output });
		const answered = (approver as NonNullable<typeof approver>)("github.com", 443);
		input.push("y\n");
		await answered;

		expect(written()).toContain("github.com:443");
		expect(written()).toContain("network.allowedHosts");
	});

	it("grants on an affirmative answer", async () => {
		const { input, output } = terminal(true);
		const approver = createHostApprover({ handoff: recordingHandoff([]), input, output });
		const answered = (approver as NonNullable<typeof approver>)("github.com", 443);
		input.push("y\n");

		await expect(answered).resolves.toBe(true);
	});

	it("declines on anything else, including a bare newline", async () => {
		const { input, output } = terminal(true);
		const approver = createHostApprover({ handoff: recordingHandoff([]), input, output });
		const answered = (approver as NonNullable<typeof approver>)("github.com", 443);
		input.push("\n");

		await expect(answered).resolves.toBe(false);
	});

	it("declines rather than granting when the answer cannot be read", async () => {
		const { input, output } = terminal(true);
		const approver = createHostApprover({ handoff: recordingHandoff([]), input, output });
		const answered = (approver as NonNullable<typeof approver>)("github.com", 443);
		input.emit("error", new Error("terminal went away"));

		await expect(answered).resolves.toBe(false);
	});

	it("borrows the terminal around the prompt and returns it afterwards", async () => {
		const events: string[] = [];
		const { input, output } = terminal(true);
		const approver = createHostApprover({ handoff: recordingHandoff(events), input, output });
		const answered = (approver as NonNullable<typeof approver>)("github.com", 443);
		input.push("n\n");
		await answered;

		expect(events).toEqual(["borrow", "return"]);
	});
});
