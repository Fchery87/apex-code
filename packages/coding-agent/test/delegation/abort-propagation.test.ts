import { describe, expect, it, vi } from "vitest";
import {
	ChildRunRegistry,
	type ChildSessionHandle,
	type ChildSessionStatus,
	type ChildTurnResult,
	type DelegationRuntimeOptions,
	runDelegation,
} from "../../src/core/delegation/runtime.ts";
import type { Capability } from "../../src/core/tools/contract.ts";
import { createDelegateTool } from "../../src/core/tools/delegate.ts";

function caps(...values: Capability[]): ReadonlySet<Capability> {
	return new Set(values);
}

/** A child whose turn runs until it is interrupted, then settles with its partial output. */
function interruptibleChild() {
	let status: ChildSessionStatus = "running";
	let latest: ChildTurnResult | undefined;
	let resolveRun!: (value: { output: string }) => void;
	const runPromise = new Promise<{ output: string }>((resolve) => {
		resolveRun = resolve;
	});
	const interrupt = vi.fn(() => {
		status = "interrupted";
		latest = { outcome: "interrupted", output: "partial" };
		resolveRun({ output: "partial" });
	});
	const handle: ChildSessionHandle = {
		get status() {
			return status;
		},
		run: () => runPromise,
		latestResult: () => latest,
		wait: async () => {},
		interrupt,
		close: () => {},
		sendInput: async () => {},
		followUp: async () => {},
		dispose: () => {},
	};
	return { handle, interrupt };
}

function runtimeWith(child: ReturnType<typeof interruptibleChild>): DelegationRuntimeOptions {
	return {
		resolveAgent: (agentType) =>
			agentType === "scout"
				? { name: "scout", description: "recon", tools: ["read"], systemPrompt: "scout" }
				: undefined,
		getParentCapabilities: () => caps("fs.read", "delegate"),
		getToolCapabilities: (toolName) => (toolName === "read" ? caps("fs.read") : undefined),
		getDelegationDepth: () => 0,
		maxDelegationDepth: 2,
		buildChildSession: vi.fn(async () => child.handle),
		childRunRegistry: new ChildRunRegistry(),
	} as DelegationRuntimeOptions;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
	return Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms))]);
}

describe("aborting a foreground delegation (HR.12)", () => {
	it("aborting the delegate call's signal interrupts the child and returns its partial output", async () => {
		const child = interruptibleChild();
		const tool = createDelegateTool(runtimeWith(child));
		const controller = new AbortController();
		const call = tool.execute("call-1", { agentType: "scout", task: "recon" } as never, controller.signal);
		setTimeout(() => controller.abort(), 10);

		const result = await within(call, 2000);
		expect(result).not.toBe("timed out");
		expect(child.interrupt).toHaveBeenCalledTimes(1);
		expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe("partial");
	});

	it("a call whose signal is already aborted interrupts the child at once", async () => {
		const child = interruptibleChild();
		const tool = createDelegateTool(runtimeWith(child));
		const controller = new AbortController();
		controller.abort();
		const result = await within(
			tool.execute("call-2", { agentType: "scout", task: "recon" } as never, controller.signal),
			2000,
		);
		expect(result).not.toBe("timed out");
		expect(child.interrupt).toHaveBeenCalledTimes(1);
	});

	it("a background delegation is not interrupted by a foreground abort", async () => {
		const child = interruptibleChild();
		const runtime = runtimeWith(child);
		const launched = await runDelegation(runtime, "scout", "recon", { background: true });
		expect(launched.handleId).toBeDefined();
		runtime.childRunRegistry?.interruptForeground("parent aborted");
		expect(child.interrupt).not.toHaveBeenCalled();
	});
});
