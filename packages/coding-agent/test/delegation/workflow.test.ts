import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { runDelegation } from "../../src/core/delegation/runtime.ts";
import { runWorkflow } from "../../src/core/delegation/workflow-run.ts";
import type { Capability } from "../../src/core/tools/contract.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function sessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-workflow-"));
	scratch.push(dir);
	return dir;
}
function caps(...values: Capability[]): ReadonlySet<Capability> {
	return new Set(values);
}
function scout(): AgentDefinition {
	return { name: "explore", description: "reads", tools: ["read"], systemPrompt: "read only" };
}
function definition(steps: unknown[], output: unknown = { from: "one" }): unknown {
	return { version: 1, steps, output };
}
function request(def: unknown, args?: unknown): unknown {
	return { kind: "inline", definition: def, args };
}
function options(
	buildChildSession: DelegationRuntimeOptions["buildChildSession"] = async () => {
		throw new Error("no child");
	},
): DelegationRuntimeOptions {
	return {
		resolveAgent: (agentType) => (agentType === "explore" ? scout() : undefined),
		getParentCapabilities: () => caps("fs.read", "delegate"),
		getToolCapabilities: (toolName) => (toolName === "read" ? caps("fs.read") : undefined),
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		getParentSessionDir: sessionDir,
		buildChildSession,
	};
}
function child(output: (task: string) => string | Promise<string>) {
	return async () => ({
		status: "idle" as const,
		run: async (task: string) => ({ output: await output(task) }),
		latestResult: () => undefined,
		wait: async () => {},
		interrupt: () => {},
		close: () => {},
		sendInput: async () => {},
		followUp: async () => {},
		dispose: () => {},
	});
}

describe("runWorkflow", () => {
	it.each([false, true])("cancels pending construction and cleans late handles (late=%s)", async (late) => {
		const cwd = process.cwd();
		process.chdir(sessionDir());
		const run = vi.fn(async () => ({ output: "ok" }));
		const close = vi.fn();
		const dispose = vi.fn();
		let finish!: (handle: Awaited<ReturnType<DelegationRuntimeOptions["buildChildSession"]>>) => void;
		const runtime = options(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		runtime.maxConcurrentChildren = 1;
		try {
			const result = await Promise.race([
				runWorkflow(
					runtime,
					request({ version: 1, timeoutMs: 20, steps: [{ id: "one", prompt: "build" }], output: { from: "one" } }),
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("construction did not cancel within bound")), 300),
				),
			]);
			expect(result.outcome).toBe("cancelled");
			if (late) {
				finish({ ...(await child(() => "ok")()), run, close, dispose });
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(run).not.toHaveBeenCalled();
				expect(close).toHaveBeenCalledOnce();
				expect(dispose).toHaveBeenCalledOnce();
			}
			runtime.buildChildSession = child(() => "replacement");
			await expect(runDelegation(runtime, "explore", "replacement")).resolves.toMatchObject({
				output: "replacement",
			});
		} finally {
			runtime.childRunRegistry?.dispose();
			process.chdir(cwd);
		}
	});

	it("returns structured stop-on-failure outcomes", async () => {
		const cwd = process.cwd();
		process.chdir(sessionDir());
		const runtime = options(
			child(async (task) => {
				if (task === "fail") throw new Error("step failed");
				return new Promise<string>(() => {});
			}),
		);
		try {
			const result = await runWorkflow(
				runtime,
				request(
					definition([
						{ id: "one", prompt: "fail" },
						{ id: "sibling", prompt: "hang" },
						{ id: "dependent", needs: ["one"], prompt: "blocked" },
					]),
				),
			);
			expect(result.outcome).toBe("failed");
			expect(result.value).toBeUndefined();
			expect(result.calls.map(({ stepId, outcome }) => [stepId, outcome])).toEqual([
				["one", "failed"],
				["sibling", "cancelled"],
				["dependent", "blocked"],
			]);
		} finally {
			runtime.childRunRegistry?.dispose();
			process.chdir(cwd);
		}
	});
	it.each(["deadline", "parent"])(
		"returns cancellation outcomes for an uncooperative child on %s",
		async (cause) => {
			const cwd = process.cwd();
			process.chdir(sessionDir());
			const interrupt = vi.fn();
			const close = vi.fn();
			const build = vi.fn(async () => ({
				...(await child(() => "unused")()),
				status: "running" as const,
				run: () => new Promise<{ output: string }>(() => {}),
				interrupt,
				close,
			}));
			const runtime = options(build);
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const startedAt = Date.now();
				if (cause === "parent") timer = setTimeout(() => controller.abort(), 20);
				const result = await runWorkflow(
					runtime,
					request({
						version: 1,
						concurrency: 1,
						timeoutMs: cause === "deadline" ? 20 : 1000,
						steps: [
							{ id: "one", prompt: "never settle" },
							{ id: "queued", prompt: "never start" },
							{ id: "dependent", needs: ["one"], prompt: "never start" },
						],
						output: { from: "one" },
					}),
					{ signal: controller.signal },
				);
				expect(result.outcome).toBe("cancelled");
				expect(result.calls.map((call) => [call.stepId, call.outcome])).toEqual([
					["one", "cancelled"],
					["queued", "cancelled"],
					["dependent", "blocked"],
				]);
				expect(Date.now() - startedAt).toBeLessThan(5000);
				expect(build).toHaveBeenCalledOnce();
				expect(interrupt).toHaveBeenCalled();
				expect(close).toHaveBeenCalledOnce();
				expect(runtime.childRunRegistry?.list()).toHaveLength(1);
				expect(runtime.childRunRegistry?.list()[0]?.status).toBe("closed");
			} finally {
				clearTimeout(timer);
				runtime.childRunRegistry?.dispose();
				process.chdir(cwd);
			}
		},
		5000,
	);
	it("refuses executable JavaScript before dispatch", async () => {
		const build = vi.fn(options().buildChildSession);
		await expect(runWorkflow({ ...options(), buildChildSession: build }, "return 1")).rejects.toThrow(
			/JavaScript|JSON/,
		);
		expect(build).not.toHaveBeenCalled();
	});
	it("runs a worker definition and returns the declared output", async () => {
		const build = vi.fn(child((task) => `result:${task}`));
		const result = await runWorkflow(
			{ ...options(), buildChildSession: build },
			request(definition([{ id: "one", prompt: "scan" }])),
		);
		expect(result.value).toBe("result:scan");
		expect(result.calls[0]?.stepId).toBe("one");
	});
	it("passes predecessor output through a pipeline reference", async () => {
		const build = vi.fn(child((task) => (task === "first" ? JSON.stringify({ value: "next" }) : `saw:${task}`)));
		const result = await runWorkflow(
			{ ...options(), buildChildSession: build },
			request(
				definition(
					[
						{ id: "one", prompt: "first" },
						{ id: "two", needs: ["one"], prompt: [{ from: "one", pointer: "/value" }] },
					],
					{ from: "two" },
				),
			),
		);
		expect(result.value).toBe("saw:next");
		expect(result.calls.map((call) => call.stepId)).toEqual(["one", "two"]);
	});
	it("validates a worker output against its declared schema before returning it", async () => {
		const build = vi.fn(child(() => '{"files":["a.ts"]}'));
		const result = await runWorkflow(
			{ ...options(), buildChildSession: build },
			request(
				definition([
					{
						id: "one",
						prompt: "list files",
						schema: {
							type: "object",
							properties: { files: { type: "array", items: { type: "string" } } },
							required: ["files"],
							additionalProperties: false,
						},
					},
				]),
			),
		);
		expect(result.value).toEqual({ files: ["a.ts"] });
	});
	it("preserves independent step identity and declared phase", async () => {
		const build = vi.fn(child((task) => task));
		const result = await runWorkflow(
			{ ...options(), buildChildSession: build },
			request(
				definition(
					[
						{ id: "a", phase: "scan", prompt: "a" },
						{ id: "b", phase: "scan", prompt: "b" },
					],
					{ from: "b" },
				),
			),
		);
		expect(result.calls.map((call) => call.stepId)).toEqual(["a", "b"]);
		expect(result.phases).toEqual([{ title: "scan", calls: 2 }]);
	});
	it.each([
		{ inherited: 12, expected: 4 },
		{ inherited: 2, expected: 2 },
	])("bounds default concurrency with inherited cap $inherited", async ({ inherited, expected }) => {
		let active = 0;
		let peak = 0;
		const build = child(async (task) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			active -= 1;
			return task;
		});
		const steps = Array.from({ length: 8 }, (_, index) => ({ id: `step${index}`, prompt: `${index}` }));

		await runWorkflow(
			{ ...options(build), maxConcurrentChildren: inherited },
			request(definition(steps, { from: "step7" })),
		);

		expect(peak).toBe(expected);
		expect(active).toBe(0);
	});
	it("does not dispatch a pre-aborted definition", async () => {
		const build = vi.fn(child((task) => task));
		const controller = new AbortController();
		controller.abort();
		await expect(
			runWorkflow({ ...options(), buildChildSession: build }, request(definition([{ id: "one", prompt: "scan" }])), {
				signal: controller.signal,
			}),
		).rejects.toThrow(/cancel/i);
		expect(build).not.toHaveBeenCalled();
	});
	it("rejects path-like run identifiers before storage access", async () => {
		await expect(
			runWorkflow(options(), request(definition([{ id: "one", prompt: "scan" }])), { runId: "../run" }),
		).rejects.toThrow(/identifier/);
	});
	it("interrupts and closes a child when the workflow deadline expires", async () => {
		const close = vi.fn();
		let finish: ((value: { output: string }) => void) | undefined;
		const interrupt = vi.fn(() => finish?.({ output: "interrupted" }));
		const build = async () => ({
			status: "running" as const,
			run: () =>
				new Promise<{ output: string }>((resolve) => {
					finish = resolve;
				}),
			latestResult: () => undefined,
			wait: async () => {},
			interrupt,
			close,
			sendInput: async () => {},
			followUp: async () => {},
			dispose: () => {},
		});
		const runtime = options(build);
		const result = runWorkflow(
			runtime,
			request({
				version: 1,
				timeoutMs: 10,
				steps: [{ id: "one", prompt: "wait" }],
				output: { from: "one" },
			}),
		);
		const assertion = expect(result).resolves.toMatchObject({ outcome: "cancelled" });
		try {
			await assertion;
			expect(interrupt).toHaveBeenCalled();
			expect(close).toHaveBeenCalledOnce();
		} finally {
			finish?.({ output: "cleanup" });
			runtime.childRunRegistry?.dispose();
		}
	}, 200);
	it("cancels independent siblings after the first step failure", async () => {
		const closes: string[] = [];
		const interrupts: string[] = [];
		let releaseSlow: (() => void) | undefined;
		const build = child(async (task) => {
			if (task === "fail") throw new Error("first step failed");
			await new Promise<void>((resolve) => {
				releaseSlow = resolve;
			});
			return task;
		});
		const originalBuild = build;
		const runtime = options(async () => {
			const handle = await originalBuild();
			const task = { interrupt: handle.interrupt, close: handle.close };
			return {
				...handle,
				interrupt: () => {
					interrupts.push("slow");
					task.interrupt();
				},
				close: () => {
					closes.push("child");
					task.close();
				},
			};
		});
		const result = runWorkflow(
			runtime,
			request(
				definition(
					[
						{ id: "failure", prompt: "fail" },
						{ id: "slow", prompt: "slow" },
					],
					{ from: "failure" },
				),
			),
		);

		await expect(result).resolves.toMatchObject({
			outcome: "failed",
			calls: [
				{ stepId: "failure", outcome: "failed" },
				{ stepId: "slow", outcome: "cancelled" },
			],
		});
		releaseSlow?.();
		expect(interrupts.length).toBeGreaterThan(0);
		expect(closes.length).toBeGreaterThan(0);
	});
	it("records failed and blocked steps while continuing independent branches", async () => {
		const build = child(async (task) => {
			if (task === "fail") throw new Error("branch failed");
			return task;
		});
		const result = await runWorkflow(
			options(build),
			request({
				version: 1,
				failurePolicy: "continue-independent",
				steps: [
					{ id: "failure", prompt: "fail" },
					{ id: "independent", prompt: "keep going" },
					{ id: "blocked", needs: ["failure"], prompt: "must not run" },
				],
				output: { from: "independent" },
			}),
		);

		expect(result.outcome).toBe("failed");
		expect(result.value).toBe("keep going");
		expect(result.calls.find((call) => call.stepId === "failure")?.outcome).toBe("failed");
		expect(result.calls.find((call) => call.stepId === "blocked")?.outcome).toBe("blocked");
		expect(result.calls.find((call) => call.stepId === "independent")?.outcome).toBe("succeeded");
	});
});
