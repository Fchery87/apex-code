import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { confirmFullAccess, writeFullAccessBanner } from "../../src/core/sandbox/full-access.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import { createSandboxPolicy } from "../../src/core/sandbox/policy.ts";
import { createSandboxSupervisor } from "../../src/core/sandbox/supervisor.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-writable-roots-"));
	directories.push(directory);
	return directory;
}

describe("writable root arguments", () => {
	it("collects every --add-dir rather than keeping only the last", () => {
		expect(parseArgs(["--add-dir", "/one", "--add-dir", "/two"]).addDir).toEqual(["/one", "/two"]);
	});

	it("reports a --add-dir with no value instead of silently dropping it", () => {
		const parsed = parseArgs(["--add-dir"]);

		expect(parsed.addDir).toBeUndefined();
		expect(parsed.diagnostics.some((d) => d.type === "error")).toBe(true);
	});

	it("accepts the two sandbox modes and rejects anything else", () => {
		expect(parseArgs(["--sandbox", "enforced"]).sandbox).toBe("enforced");
		expect(parseArgs(["--sandbox", "danger-full-access"]).sandbox).toBe("danger-full-access");

		const bad = parseArgs(["--sandbox", "off"]);
		expect(bad.sandbox).toBeUndefined();
		expect(bad.diagnostics.some((d) => d.type === "error")).toBe(true);
	});
});

describe("writable root policy", () => {
	it("carries validated additional roots onto the policy", () => {
		const cwd = workspace();
		const extra = workspace();

		const result = createSandboxPolicy({ workspace: cwd, additionalWritableRoots: [extra] });

		expect(result.kind).toBe("valid");
		expect(result.kind === "valid" && result.policy.additionalWritableRoots).toEqual([extra]);
	});

	it("refuses a relative additional root rather than resolving it against something", () => {
		const result = createSandboxPolicy({ workspace: workspace(), additionalWritableRoots: ["relative/path"] });

		expect(result.kind).toBe("invalid");
	});

	it("refuses an additional root that does not exist", () => {
		const result = createSandboxPolicy({
			workspace: workspace(),
			additionalWritableRoots: [join(workspace(), "absent")],
		});

		expect(result.kind).toBe("invalid");
	});

	it("refuses a file masquerading as an additional root", () => {
		const cwd = workspace();
		const file = join(cwd, "not-a-directory");
		writeFileSync(file, "");

		expect(createSandboxPolicy({ workspace: cwd, additionalWritableRoots: [file] }).kind).toBe("invalid");
	});

	it("defaults to no additional roots, so the boundary is unchanged without the flag", () => {
		const result = createSandboxPolicy({ workspace: workspace() });

		expect(result.kind === "valid" && result.policy.additionalWritableRoots).toEqual([]);
	});
});

describe.skipIf(process.platform !== "linux" || createLinuxSandboxBackend().status.kind !== "enforced")(
	"writable roots in a real child",
	() => {
		it("makes an added directory writable while everything else stays read-only", async () => {
			const cwd = workspace();
			const extra = workspace();
			const outside = workspace();
			mkdirSync(join(extra, "nested"), { recursive: true });
			const supervisor = createSandboxSupervisor({
				backend: createLinuxSandboxBackend(),
				policy: { workspace: cwd, allowedHosts: [], additionalWritableRoots: [extra] },
			});

			try {
				await expect(
					supervisor.launch({
						command: "/bin/sh",
						args: ["-c", `touch ${join(extra, "nested", "written")} && ! touch ${join(outside, "denied")}`],
					}),
				).resolves.toBe(0);
			} finally {
				await supervisor.close();
			}
		});

		it("keeps everything outside the workspace read-only when no root is added", async () => {
			const cwd = workspace();
			const outside = workspace();
			const supervisor = createSandboxSupervisor({
				backend: createLinuxSandboxBackend(),
				policy: { workspace: cwd, allowedHosts: [], additionalWritableRoots: [] },
			});

			try {
				await expect(
					supervisor.launch({ command: "/bin/sh", args: ["-c", `touch ${join(outside, "denied")}`] }),
				).resolves.not.toBe(0);
			} finally {
				await supervisor.close();
			}
		});
	},
);

describe("full access opt-out", () => {
	function terminal(isTTY: boolean) {
		const input = new PassThrough() as unknown as NodeJS.ReadStream;
		const output = new PassThrough() as unknown as NodeJS.WriteStream;
		let written = "";
		output.on("data", (chunk: Buffer) => {
			written += chunk.toString();
		});
		(input as unknown as { isTTY: boolean }).isTTY = isTTY;
		(output as unknown as { isTTY: boolean }).isTTY = isTTY;
		return { input, output, written: () => written };
	}

	it("says plainly what stops being enforced", () => {
		let written = "";
		writeFullAccessBanner({
			write(message: string) {
				written += message;
				return true;
			},
		});

		expect(written).toContain("OS sandbox disabled");
		expect(written).toContain("full account authority");
		// The distinction the README and user guide now make, repeated where it is easiest
		// to misread: the gate is not the boundary.
		expect(written).toContain("not a containment boundary");
	});

	it("requires an affirmative answer at a terminal", async () => {
		const yes = terminal(true);
		const granted = confirmFullAccess(yes);
		yes.input.push("y\n");
		await expect(granted).resolves.toBe(true);

		const no = terminal(true);
		const refused = confirmFullAccess(no);
		no.input.push("\n");
		await expect(refused).resolves.toBe(false);
	});

	it("does not prompt where nobody could answer, since that would hang rather than protect", async () => {
		// The case the flag legitimately exists for: CI that is already externally
		// sandboxed. The banner carries the weight there.
		await expect(confirmFullAccess(terminal(false))).resolves.toBe(true);
	});
});
