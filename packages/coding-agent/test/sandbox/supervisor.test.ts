import { describe, expect, it } from "vitest";
import { createSandboxSupervisor, type SandboxBackend, type SandboxLaunch } from "../../src/core/sandbox/supervisor.ts";

function backend(status: SandboxBackend["status"]): SandboxBackend & { launches: SandboxLaunch[]; closed: boolean } {
	const launches: SandboxLaunch[] = [];
	let closed = false;
	return {
		status,
		launches,
		get closed() {
			return closed;
		},
		async launch(launch) {
			launches.push(launch);
			return 17;
		},
		async close() {
			closed = true;
		},
	};
}

describe("SandboxSupervisor", () => {
	it("refuses to launch when its backend cannot enforce the OS boundary", async () => {
		const unavailable = backend({ kind: "unavailable", reason: "bubblewrap is unavailable" });
		const supervisor = createSandboxSupervisor({
			backend: unavailable,
			policy: { workspace: "/workspace", allowedHosts: [], additionalWritableRoots: [] },
		});

		await expect(supervisor.launch({ command: "node", args: ["cli.js"] })).rejects.toThrow(
			"bubblewrap is unavailable",
		);
		expect(unavailable.launches).toEqual([]);
	});

	it("passes only validated policy and explicit launch values to an enforcing backend", async () => {
		const enforcing = backend({ kind: "enforced" });
		const supervisor = createSandboxSupervisor({
			backend: enforcing,
			policy: { workspace: "/workspace", allowedHosts: [], additionalWritableRoots: [] },
		});

		await expect(supervisor.launch({ command: "/usr/bin/node", args: ["cli.js", "--print", "hello"] })).resolves.toBe(
			17,
		);
		expect(enforcing.launches).toEqual([
			{
				command: "/usr/bin/node",
				args: ["cli.js", "--print", "hello"],
				policy: { workspace: "/workspace", allowedHosts: [], additionalWritableRoots: [] },
			},
		]);
		await supervisor.close();
		expect(enforcing.closed).toBe(true);
	});
});
