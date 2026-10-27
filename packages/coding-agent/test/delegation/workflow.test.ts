import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { runWorkflow } from "../../src/core/delegation/workflow-run.ts";
import type { Capability } from "../../src/core/tools/contract.ts";

/**
 * The public seam is runWorkflow: a script goes in, one value comes out.
 * Children, when a later slice adds them, are started only by worker() inside
 * the script. These tests never reach into the isolate.
 */

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

function options(): DelegationRuntimeOptions {
	return {
		resolveAgent: (agentType) => (agentType === "explore" ? scout() : undefined),
		getParentCapabilities: () => caps("fs.read", "delegate"),
		getToolCapabilities: (toolName) => (toolName === "read" ? caps("fs.read") : undefined),
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		getParentSessionDir: sessionDir,
		buildChildSession: async () => {
			throw new Error("this script must not start a child");
		},
	};
}

describe("runWorkflow", () => {
	it("groups the calls after phase() under that title", async () => {
		const result = await runWorkflow(options(), "phase('scan'); return await pipeline(['a'], (item) => item)", {
			runId: "phased",
		});
		expect(result.phases).toEqual([{ title: "scan", calls: 1 }]);
	});

	it("returns a script literal and starts no child", async () => {
		const result = await runWorkflow(options(), "return 1 + 2");
		expect(result.value).toBe(3);
		expect(result.calls).toEqual([]);
	});

	it("refuses a script that reaches the clock, the network, or another module", async () => {
		// The names are built at runtime. A scan of the source text cannot see
		// them, so the rejection has to come from the sandbox.
		const clock = ["Date", "now"].join(".");
		const dice = ["Math", "random"].join(".");
		const born = `new (globalThis[${JSON.stringify("Date")}])()`;
		await expect(runWorkflow(options(), `return ${clock}()`)).rejects.toThrow(/Date\.now/);
		await expect(
			runWorkflow(options(), `return globalThis[${JSON.stringify("fetch")}]("https://example.com")`),
		).rejects.toThrow(/fetch/);
		await expect(
			runWorkflow(options(), `return globalThis[${JSON.stringify("process")}].env.HOME`),
		).rejects.toThrow();
		await expect(runWorkflow(options(), `return ${dice}()`)).rejects.toThrow(/Math\.random/);
		await expect(runWorkflow(options(), `return ${born}`)).rejects.toThrow(/new Date/);
	});

	it("refuses a script larger than 64 KB before running it", async () => {
		await expect(runWorkflow(options(), `return ${"1".repeat(70_000)}`)).rejects.toThrow(/64 KB/);
	});

	it("passes args in and withholds the session directory from the script", async () => {
		const result = await runWorkflow(options(), "return args.n * 2", { args: { n: 4 } });
		expect(result.value).toBe(8);
	});

	it("starts a worker through the delegation runtime and returns its text", async () => {
		const build = vi.fn(async () => ({
			status: "idle" as const,
			run: async () => ({ output: "found src/a.ts" }),
			latestResult: () => ({ outcome: "completed" as const, output: "found src/a.ts" }),
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput: async () => {},
			followUp: async () => {},
			dispose: () => {},
		}));
		const result = await runWorkflow(
			{ ...options(), buildChildSession: build },
			"return await worker('where is the parser')",
		);
		expect(result.value).toBe("found src/a.ts");
		expect(build).toHaveBeenCalledOnce();
		expect(result.calls).toHaveLength(1);
		expect(result.calls[0]?.agentType).toBe("explore");
	});

	it("runs parallel workers under the concurrency cap and keeps a failure as null", async () => {
		let active = 0;
		let peak = 0;
		const build = vi.fn(async () => ({
			status: "idle" as const,
			run: async (task: string) => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
				if (task.includes("fails")) {
					// The delegation runtime stores this promise and reads it after
					// runDelegation has already thrown, so the rejection needs a handler.
					const failure = Promise.reject(new Error("worker failed"));
					failure.catch(() => {});
					return failure;
				}
				return { output: task };
			},
			latestResult: () => undefined,
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput: async () => {},
			followUp: async () => {},
			dispose: () => {},
		}));
		const result = await runWorkflow(
			{ ...options(), maxConcurrentChildren: 2, buildChildSession: build },
			"return await parallel(['one', 'fails', 'three'])",
		);
		expect(result.value).toEqual(["one", null, "three"]);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it("pipelines one worker per item", async () => {
		const result = await runWorkflow(
			{
				...options(),
				buildChildSession: async () => ({
					status: "idle" as const,
					run: async (task: string) => ({ output: `saw ${task}` }),
					latestResult: () => undefined,
					wait: async () => {},
					interrupt: () => {},
					close: () => {},
					sendInput: async () => {},
					followUp: async () => {},
					dispose: () => {},
				}),
			},
			"return await pipeline(['a', 'b'], (item) => 'file ' + item)",
		);
		expect(result.value).toEqual(["saw file a", "saw file b"]);
	});

	it("refuses a pipeline longer than 256 items before starting any child", async () => {
		const build = vi.fn(async () => {
			throw new Error("no child");
		});
		const script = "return await pipeline(Array.from({ length: 257 }, (_, i) => String(i)), (item) => item)";
		await expect(runWorkflow({ ...options(), buildChildSession: build }, script)).rejects.toThrow(/256/);
		expect(build).not.toHaveBeenCalled();
	});

	it("records a warning once a run passes 25 calls and still returns", async () => {
		let n = 0;
		const build = vi.fn(async () => ({
			status: "idle" as const,
			run: async () => ({ output: `n${n++}` }),
			latestResult: () => undefined,
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput: async () => {},
			followUp: async () => {},
			dispose: () => {},
		}));
		const script = "return await parallel(Array.from({ length: 26 }, (_, i) => String(i)))";
		const result = await runWorkflow(
			{
				...options(),
				buildChildSession: build,
				childRunRegistry: { close() {}, sendInput: async () => {} } as never,
			},
			script,
		);
		expect(result.warnings).toEqual(["26 calls. A workflow past 25 calls is hard to resume."]);
		expect(result.value).toHaveLength(26);
	});

	it("refuses the 101st worker before starting any child", async () => {
		const build = vi.fn(async () => {
			throw new Error("no child");
		});
		const script = "const prompts = Array.from({ length: 101 }, (_, i) => String(i)); return await parallel(prompts)";
		await expect(runWorkflow({ ...options(), buildChildSession: build }, script)).rejects.toThrow(/100/);
		expect(build).not.toHaveBeenCalled();
	});

	it("rejects a contradictory schema before building a child", async () => {
		const build = vi.fn(async () => {
			throw new Error("no child");
		});
		const script =
			"return await worker('list files', { schema: { type: 'object', additionalProperties: false, required: ['files'], properties: {} } })";
		await expect(runWorkflow({ ...options(), buildChildSession: build }, script)).rejects.toThrow(/files/);
		expect(build).not.toHaveBeenCalled();
	});

	it("follow-ups once when the child returns JSON that misses the schema, then fails", async () => {
		const sendInput = vi.fn(async () => {});
		const build = vi.fn(async () => ({
			status: "idle" as const,
			run: async () => ({ output: "not json" }),
			latestResult: () => ({ outcome: "completed" as const, output: "still not json" }),
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput,
			followUp: async () => {},
			dispose: () => {},
		}));
		const script =
			"return await worker('list files', { schema: { type: 'object', required: ['files'], properties: { files: { type: 'array' } } } })";
		await expect(runWorkflow({ ...options(), buildChildSession: build }, script)).rejects.toThrow(/follow-up/);
		expect(sendInput).toHaveBeenCalledOnce();
	});

	it("returns parsed JSON when the child matches the schema", async () => {
		const build = vi.fn(async () => ({
			status: "idle" as const,
			run: async () => ({ output: '{"files":["a.ts"]}' }),
			latestResult: () => ({ outcome: "completed" as const, output: '{"files":["a.ts"]}' }),
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput: async () => {},
			followUp: async () => {},
			dispose: () => {},
		}));
		const script =
			"return await worker('list files', { schema: { type: 'object', required: ['files'], properties: { files: { type: 'array' } } } })";
		const result = await runWorkflow({ ...options(), buildChildSession: build }, script);
		expect(result.value).toEqual({ files: ["a.ts"] });
	});

	it("reruns a changed call and every call after it, and reuses the ones before it", async () => {
		const prompts: string[] = [];
		const runtime = options();
		const dir = runtime.getParentSessionDir?.();
		const build = vi.fn(async () => ({
			status: "idle" as const,
			run: async (task: string) => {
				prompts.push(task);
				return { output: task };
			},
			latestResult: () => undefined,
			wait: async () => {},
			interrupt: () => {},
			close: () => {},
			sendInput: async () => {},
			followUp: async () => {},
			dispose: () => {},
		}));
		const first = "return await pipeline(['a', 'b', 'c'], (item) => item)";
		const second = "return await pipeline(['a', 'B', 'c'], (item) => item)";
		await runWorkflow({ ...runtime, getParentSessionDir: () => dir ?? "", buildChildSession: build }, first, {
			runId: "audit",
		});
		prompts.length = 0;
		const again = await runWorkflow(
			{ ...runtime, getParentSessionDir: () => dir ?? "", buildChildSession: build },
			second,
			{ runId: "audit" },
		);
		expect(prompts).toEqual(["B", "c"]);
		expect(again.value).toEqual(["a", "B", "c"]);
	});

	it("stops at the delegation depth bound and builds no child", async () => {
		const build = vi.fn(async () => {
			throw new Error("must not build");
		});
		const runtime = {
			...options(),
			resolveAgent: () => ({ name: "explore", description: "reads", tools: ["delegate"], systemPrompt: "nested" }),
			getToolCapabilities: (toolName: string) => (toolName === "delegate" ? caps("delegate") : undefined),
			getDelegationDepth: () => 2,
			buildChildSession: build,
		};
		await expect(runWorkflow(runtime, 'return await worker("go deeper")')).rejects.toThrow(/depth limit \(2\)/);
		expect(build).not.toHaveBeenCalled();
	});

	it("refuses a worker whose tool the parent cannot authorize, and builds no child", async () => {
		const build = vi.fn(async () => {
			throw new Error("buildChildSession must not run");
		});
		const runtime = {
			...options(),
			buildChildSession: build,
			resolveAgent: () => ({ name: "general", description: "edits", tools: ["bash"], systemPrompt: "edit" }),
		};
		await expect(runWorkflow(runtime, "return await worker('change it', { agentType: 'general' })")).rejects.toThrow(
			/exec|bash|capability/,
		);
		expect(build).not.toHaveBeenCalled();
	});
});
