import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBwrapArguments } from "../../src/core/sandbox/bwrap-arguments.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import {
	escalationRootFor,
	extractRefusedPath,
	looksLikeSandboxRefusal,
	requestCommandEscalation,
} from "../../src/core/sandbox/rpc/command-client.ts";
import {
	createCommandEscalationProxy,
	resolveCommandEscalationChannelPaths,
} from "../../src/core/sandbox/rpc/command-proxy.ts";
import { createSandboxSupervisor } from "../../src/core/sandbox/supervisor.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function directory(prefix: string): string {
	const created = mkdtempSync(join(tmpdir(), prefix));
	directories.push(created);
	return created;
}

function ask(path: string, request: unknown): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(path, () => socket.write(`${JSON.stringify(request)}\n`));
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				socket.destroy();
				resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
			}
		});
		socket.on("error", reject);
	});
}

describe.skipIf(process.platform === "win32")("command escalation channel", () => {
	it("runs an approved command and returns its output", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async () => true,
			runEscalated: async () => ({ code: 0, stdout: "written", stderr: "" }),
		});
		closers.push(proxy.close);

		await expect(
			ask(channel.hostSocketPath, { op: "run", command: "touch /outside/x", writableRoot: "/outside" }),
		).resolves.toMatchObject({ ok: true, code: 0, stdout: "written" });
	});

	it("does not run a refused command at all", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		let ran = 0;
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async () => false,
			runEscalated: async () => {
				ran += 1;
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		closers.push(proxy.close);

		await expect(
			ask(channel.hostSocketPath, { op: "run", command: "rm -rf /", writableRoot: "/" }),
		).resolves.toMatchObject({ ok: false });
		expect(ran).toBe(0);
	});

	it("refuses without asking when no approver exists, keeping headless at deny", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		let ran = 0;
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			runEscalated: async () => {
				ran += 1;
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		closers.push(proxy.close);

		await expect(
			ask(channel.hostSocketPath, { op: "run", command: "touch /outside/x", writableRoot: "/outside" }),
		).resolves.toMatchObject({ ok: false });
		expect(ran).toBe(0);
	});

	it("asks about every command, since one approval must not cover the next", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		const asked: string[] = [];
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async (request) => {
				asked.push(request.command);
				return true;
			},
			runEscalated: async () => ({ code: 0, stdout: "", stderr: "" }),
		});
		closers.push(proxy.close);

		await ask(channel.hostSocketPath, { op: "run", command: "first", writableRoot: "/outside" });
		await ask(channel.hostSocketPath, { op: "run", command: "second", writableRoot: "/outside" });

		expect(asked).toEqual(["first", "second"]);
	});

	it("audits both the refusal and the run", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		const violationStore = new SandboxViolationStore();
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async (request) => request.command === "allowed",
			runEscalated: async () => ({ code: 0, stdout: "", stderr: "" }),
			violationStore,
		});
		closers.push(proxy.close);

		await ask(channel.hostSocketPath, { op: "run", command: "denied", writableRoot: "/outside" });
		await ask(channel.hostSocketPath, { op: "run", command: "allowed", writableRoot: "/outside" });

		expect(violationStore.list().map((v) => v.command)).toEqual(["denied", "allowed"]);
	});

	it("serves no operation other than run", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async () => true,
			runEscalated: async () => ({ code: 0, stdout: "", stderr: "" }),
		});
		closers.push(proxy.close);

		await expect(
			ask(channel.hostSocketPath, { op: "mount", command: "x", writableRoot: "/" }),
		).resolves.toMatchObject({ ok: false });
	});
});

describe("bwrap argument builder", () => {
	it("binds each additional writable root the same way it binds the workspace", () => {
		const argv = buildBwrapArguments({
			workspace: "/ws",
			additionalWritableRoots: ["/extra"],
			readOnlyPaths: [],
			readOnlyFiles: [],
			readOnlyBinaries: [],
			sockets: [],
			environment: {},
			command: "/bin/sh",
			args: ["-c", "true"],
		});

		expect(argv.join(" ")).toContain("--bind /ws /ws");
		expect(argv.join(" ")).toContain("--bind /extra /extra");
	});

	it("keeps the containment flags no caller can opt out of", () => {
		const argv = buildBwrapArguments({
			workspace: "/ws",
			additionalWritableRoots: [],
			readOnlyPaths: [],
			readOnlyFiles: [],
			readOnlyBinaries: [],
			sockets: [],
			environment: {},
			command: "/bin/sh",
			args: [],
		});

		// The escalated child derives from this same builder, so these are the flags it
		// cannot lose by being constructed somewhere else.
		for (const flag of ["--unshare-net", "--unshare-pid", "--unshare-user", "--die-with-parent"]) {
			expect(argv).toContain(flag);
		}
		expect(argv.join(" ")).toContain("--tmpfs /home");
	});
});

describe.skipIf(process.platform !== "linux" || createLinuxSandboxBackend().status.kind !== "enforced")(
	"command escalation in a real child",
	() => {
		it("runs the approved command outside the boundary while the session stays confined", async () => {
			const workspace = directory("apex-escalation-ws-");
			const outside = directory("apex-escalation-outside-");
			const target = join(outside, "written");
			const channel = resolveCommandEscalationChannelPaths();
			directories.push(channel.hostSocketDirectory);

			const backend = createLinuxSandboxBackend();
			const supervisor = createSandboxSupervisor({
				backend,
				policy: { workspace, allowedHosts: [], additionalWritableRoots: [] },
			});

			try {
				// 1. The session cannot write there.
				await expect(supervisor.launch({ command: "/bin/sh", args: ["-c", `touch ${target}`] })).resolves.not.toBe(
					0,
				);
				expect(existsSync(target)).toBe(false);

				// 2. An approved escalation can, in its own child.
				const proxy = await createCommandEscalationProxy({
					socketPath: channel.hostSocketPath,
					requestApproval: async () => true,
					runEscalated: async (request) => {
						const escalated = createSandboxSupervisor({
							backend: createLinuxSandboxBackend(),
							policy: { workspace, allowedHosts: [], additionalWritableRoots: [request.writableRoot] },
						});
						const code = await escalated.launch({ command: "/bin/sh", args: ["-c", request.command] });
						await escalated.close();
						return { code, stdout: "", stderr: "" };
					},
				});
				closers.push(proxy.close);

				await expect(
					ask(channel.hostSocketPath, { op: "run", command: `touch ${target}`, writableRoot: outside }),
				).resolves.toMatchObject({ ok: true, code: 0 });
				expect(existsSync(target)).toBe(true);

				// 3. The property that makes this sound: the session's own namespace was
				// never widened, so it is refused exactly as it was before the approval.
				rmSync(target, { force: true });
				await expect(supervisor.launch({ command: "/bin/sh", args: ["-c", `touch ${target}`] })).resolves.not.toBe(
					0,
				);
				expect(existsSync(target)).toBe(false);
			} finally {
				await supervisor.close();
			}
		});
	},
);

describe.skipIf(process.platform === "win32")("recognising a boundary refusal in command output", () => {
	it("finds the path in the wordings the shell and kernel actually produce", () => {
		// Every string here was copied from a real refusal in this repo's own test output.
		expect(extractRefusedPath("/bin/sh: 1: cannot create /tmp/x.txt: Read-only file system")).toBe("/tmp/x.txt");
		expect(extractRefusedPath("sh: /outside/file.txt: Operation not permitted")).toBe("/outside/file.txt");
		expect(extractRefusedPath("touch: cannot touch '/opt/thing': Permission denied")).toBe("/opt/thing");
	});

	it("finds nothing in an ordinary failure, so no escalation is offered for one", () => {
		expect(extractRefusedPath("error: invalid API key")).toBeUndefined();
		expect(extractRefusedPath("2 tests failed")).toBeUndefined();
		expect(looksLikeSandboxRefusal("2 tests failed")).toBe(false);
	});

	it("refuses a relative path rather than resolving it against something", () => {
		expect(extractRefusedPath("cannot create out.txt: Read-only file system")).toBeUndefined();
	});

	it("asks for the parent directory, because the refused file does not exist yet", () => {
		expect(escalationRootFor("/outside/nested/written.txt")).toBe("/outside/nested");
	});

	it("returns nothing when there is no channel to ask", async () => {
		await expect(
			requestCommandEscalation({ command: "touch /x", writableRoot: "/" }, undefined),
		).resolves.toBeUndefined();
	});

	it("returns nothing when the supervisor refuses, so the caller reports the original error", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async () => false,
			runEscalated: async () => ({ code: 0, stdout: "", stderr: "" }),
		});
		closers.push(proxy.close);

		await expect(
			requestCommandEscalation({ command: "touch /x", writableRoot: "/" }, channel.hostSocketPath),
		).resolves.toBeUndefined();
	});

	it("returns the outcome when the supervisor ran it", async () => {
		const channel = resolveCommandEscalationChannelPaths();
		directories.push(channel.hostSocketDirectory);
		const proxy = await createCommandEscalationProxy({
			socketPath: channel.hostSocketPath,
			requestApproval: async () => true,
			runEscalated: async () => ({ code: 0, stdout: "ok", stderr: "" }),
		});
		closers.push(proxy.close);

		await expect(
			requestCommandEscalation({ command: "touch /x", writableRoot: "/outside" }, channel.hostSocketPath),
		).resolves.toEqual({ code: 0, stdout: "ok", stderr: "" });
	});
});
