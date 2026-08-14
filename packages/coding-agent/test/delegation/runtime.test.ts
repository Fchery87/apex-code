import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, ChildSessionHandle, DelegationRuntimeOptions } from "../../src/core/delegation/runtime.ts";
import { runDelegation } from "../../src/core/delegation/runtime.ts";
import type { Capability } from "../../src/core/tools/contract.ts";

function caps(...values: Capability[]): ReadonlySet<Capability> {
	return new Set(values);
}

function scoutDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "scout",
		description: "Fast recon",
		tools: ["read"],
		systemPrompt: "You are a scout.",
		...overrides,
	};
}

function fakeChild(output = "scout output"): { handle: ChildSessionHandle; run: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
	const run = vi.fn(async () => ({ output }));
	const dispose = vi.fn();
	return { handle: { run, dispose }, run, dispose };
}

function baseOptions(overrides: Partial<DelegationRuntimeOptions> = {}): DelegationRuntimeOptions {
	return {
		resolveAgent: (agentType) => (agentType === "scout" ? scoutDefinition() : undefined),
		getParentCapabilities: () => caps("fs.read", "delegate"),
		getToolCapabilities: (toolName) => (toolName === "read" ? caps("fs.read") : toolName === "bash" ? caps("exec") : undefined),
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		buildChildSession: vi.fn(async () => fakeChild().handle),
		...overrides,
	};
}

describe("runDelegation", () => {
	it("runs the child and returns its output on the happy path", async () => {
		const { handle, run, dispose } = fakeChild("found it in config.ts");
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({ buildChildSession });

		const result = await runDelegation(options, "scout", "find the config loader");

		expect(result).toEqual({ agentType: "scout", task: "find the config loader", output: "found it in config.ts" });
		expect(run).toHaveBeenCalledWith("find the config loader");
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("passes the definition's exact tool list to buildChildSession -- never taken from anywhere else", async () => {
		const { handle } = fakeChild();
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({
			resolveAgent: () => scoutDefinition({ tools: ["read", "grep"] }),
			getToolCapabilities: (toolName) =>
				toolName === "read" ? caps("fs.read") : toolName === "grep" ? caps("fs.read") : undefined,
			buildChildSession,
		});

		await runDelegation(options, "scout", "task");

		expect(buildChildSession).toHaveBeenCalledWith(
			expect.objectContaining({ agentType: "scout", toolNames: ["read", "grep"] }),
		);
	});

	it("throws for an unknown agent type and never builds a child", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({ resolveAgent: () => undefined, buildChildSession });

		await expect(runDelegation(options, "ghost", "task")).rejects.toThrow(/unknown agent type/i);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("throws for a definition naming an unknown tool and never builds a child", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({
			resolveAgent: () => scoutDefinition({ tools: ["nonexistent_tool"] }),
			getToolCapabilities: () => undefined,
			buildChildSession,
		});

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/unknown tool/i);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("refuses a definition naming bash under a parent without exec, naming the capability, and never yields a child holding bash", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({
			// Parent's own authority: fs.read + delegate only. No exec anywhere.
			getParentCapabilities: () => caps("fs.read", "delegate"),
			resolveAgent: () => scoutDefinition({ name: "worker", tools: ["read", "bash"] }),
			buildChildSession,
		});

		await expect(runDelegation(options, "worker", "run tests")).rejects.toThrow(/exec/);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("admits a request when the parent holds exec (escalation rule, contracts.md §1.1)", async () => {
		const { handle } = fakeChild("ran the tests");
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({
			getParentCapabilities: () => caps("exec"),
			resolveAgent: () => scoutDefinition({ name: "worker", tools: ["read", "bash"] }),
			buildChildSession,
		});

		const result = await runDelegation(options, "worker", "run tests");
		expect(result.output).toBe("ran the tests");
	});

	it("passes the parent depth + 1 to buildChildSession as the child's depth", async () => {
		const { handle } = fakeChild();
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({ getDelegationDepth: () => 1, maxDelegationDepth: 5, buildChildSession });

		await runDelegation(options, "scout", "task");

		expect(buildChildSession).toHaveBeenCalledWith(expect.objectContaining({ depth: 2 }));
	});

	it("refuses to delegate at the depth bound, naming the bound, and never builds a child", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({ getDelegationDepth: () => 2, maxDelegationDepth: 2, buildChildSession });

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/depth/i);
		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/2/);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("refuses past the depth bound too, not only exactly at it", async () => {
		const buildChildSession = vi.fn();
		const options = baseOptions({ getDelegationDepth: () => 5, maxDelegationDepth: 2, buildChildSession });

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/depth/i);
		expect(buildChildSession).not.toHaveBeenCalled();
	});

	it("still admits delegation one level below the bound", async () => {
		const { handle } = fakeChild("ok");
		const buildChildSession = vi.fn(async () => handle);
		const options = baseOptions({ getDelegationDepth: () => 1, maxDelegationDepth: 2, buildChildSession });

		const result = await runDelegation(options, "scout", "task");
		expect(result.output).toBe("ok");
	});

	it("disposes the child even when run() rejects", async () => {
		const dispose = vi.fn();
		const run = vi.fn(async () => {
			throw new Error("child crashed");
		});
		const buildChildSession = vi.fn(async () => ({ run, dispose }) as ChildSessionHandle);
		const options = baseOptions({ buildChildSession });

		await expect(runDelegation(options, "scout", "task")).rejects.toThrow(/child crashed/);
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
