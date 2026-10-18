import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCoordinator } from "../src/experimental/coordinator.ts";
import { spawnInternalProcess } from "../src/experimental/process.ts";

describe("coordinator startup timeout", () => {
	let directory: string | undefined;
	let child: ChildProcess | undefined;

	afterEach(async () => {
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		child = undefined;
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("kills the coordinator child it spawned when startup times out", async () => {
		directory = await mkdtemp(join(tmpdir(), "coord-startup-"));
		await expect(
			ensureCoordinator(join(directory, "public.sock"), join(directory, "control.sock"), {
				startTimeoutMs: 1,
				spawnChild: (role, args) => {
					child = spawnInternalProcess(role, args);
					return child;
				},
			}),
		).rejects.toThrow("Timed out waiting for coordinator startup");
		expect(child).toBeDefined();
		const exited = await new Promise<boolean>((resolve) => {
			if (child!.exitCode !== null || child!.signalCode !== null) return resolve(true);
			const timer = setTimeout(() => resolve(false), 5_000);
			child!.once("exit", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		expect(exited).toBe(true);
	});
});
