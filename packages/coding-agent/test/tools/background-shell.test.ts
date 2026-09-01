import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundShellRegistry } from "../../src/core/tools/background-shell.ts";
import { OutputAccumulator } from "../../src/core/tools/output-accumulator.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function newAccumulator(): OutputAccumulator {
	const directory = mkdtempSync(join(tmpdir(), "apex-bg-shell-"));
	directories.push(directory);
	return new OutputAccumulator({ tempFilePrefix: join(directory, "bg") });
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/** A real detached sleeper whose exit is observable, for kill and dispose tests. */
function spawnSleeper(seconds: number) {
	const child = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
	const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
	return { pid: child.pid, exited };
}

describe.skipIf(process.platform === "win32")("background shell registry", () => {
	it("reports a launched entry as running and resolves its exit", async () => {
		const registry = createBackgroundShellRegistry();
		const output = newAccumulator();
		let resolveExit: (code: number | null) => void = () => {};
		const exited = new Promise<number | null>((resolve) => {
			resolveExit = resolve;
		});

		const handle = registry.launch({ command: "long-job", output, exited });
		expect(handle).toBeTruthy();

		expect(registry.status(handle)?.running).toBe(true);
		expect(registry.status(handle)?.command).toBe("long-job");

		resolveExit(0);
		await flush();
		const status = registry.status(handle);
		expect(status?.running).toBe(false);
		expect(status?.exitCode).toBe(0);
	});

	it("retrieve reflects accumulated output and is repeatable", async () => {
		const registry = createBackgroundShellRegistry();
		const output = newAccumulator();
		let resolveExit: (code: number | null) => void = () => {};
		const exited = new Promise<number | null>((resolve) => {
			resolveExit = resolve;
		});
		const handle = registry.launch({ command: "echo-ish", output, exited });

		output.append(Buffer.from("first line\n"));
		const first = await registry.retrieve(handle);
		expect(first?.snapshot.content).toContain("first line");
		expect(first?.status.running).toBe(true);

		output.append(Buffer.from("second line\n"));
		resolveExit(3);
		await flush();
		const second = await registry.retrieve(handle);
		expect(second?.snapshot.content).toContain("second line");
		expect(second?.status.exitCode).toBe(3);
		expect(second?.status.running).toBe(false);
	});

	it("kills a running child process tree", async () => {
		const registry = createBackgroundShellRegistry();
		const output = newAccumulator();
		const { pid, exited } = spawnSleeper(30);
		const handle = registry.launch({ command: "sleep 30", pid, output, exited });

		const status = registry.kill(handle);
		expect(status?.killed).toBe(true);
		expect(await exited).toBeNull();
		expect(registry.status(handle)?.running).toBe(false);
	});

	it("dispose kills every running child", async () => {
		const registry = createBackgroundShellRegistry();
		const { pid, exited } = spawnSleeper(30);
		registry.launch({ command: "sleep 30", pid, output: newAccumulator(), exited });

		registry.dispose();
		expect(await exited).toBeNull();
	});

	it("returns undefined for unknown handles and lists known ones", async () => {
		const registry = createBackgroundShellRegistry();
		expect(await registry.retrieve("nope")).toBeUndefined();
		expect(registry.kill("nope")).toBeUndefined();

		const handle = registry.launch({ command: "x", output: newAccumulator(), exited: Promise.resolve(0) });
		expect(registry.handles()).toEqual([handle]);
		expect(registry.commandFor(handle)).toBe("x");
		expect(registry.commandFor("missing")).toBeUndefined();
	});
});
