/**
 * Runs a workflow script (spec 2026-10-26). The script is JavaScript with
 * top-level await. It has no filesystem, no network, no process, no module
 * loader, and no clock. Later slices add worker(), which is the only way a
 * script starts a child, and that call goes through runDelegation.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import {
	type ChildWorkspaceRequest,
	type DelegationRuntimeOptions,
	retrieveDelegationResult,
	runDelegation,
} from "./runtime.ts";

export const WORKFLOW_SCRIPT_MAX_BYTES = 64 * 1024;

export interface WorkflowCallRecord {
	order: number;
	agentType: string;
	prompt: string;
	hash: string;
	value?: unknown;
	failed?: string;
}

export interface WorkflowRunResult {
	value: unknown;
	calls: WorkflowCallRecord[];
	/** The phase() titles the script set, in order, with how many calls followed each. */
	phases: { title: string; calls: number }[];
	/** Set when the run passes 25 calls. The run still returns. */
	warnings: string[];
}

export interface WorkflowRunRequest {
	args?: unknown;
	/** Stable id for this run. A second start with the same id reuses finished calls. */
	runId?: string;
}

function guard(script: string): void {
	const bytes = Buffer.byteLength(script, "utf8");
	if (bytes > WORKFLOW_SCRIPT_MAX_BYTES) {
		throw new Error(`Workflow script is ${bytes} bytes, over the 64 KB limit.`);
	}
	// `import()` is syntax, so the sandbox cannot intercept it. Rejecting the
	// token is the whole check. Everything else is absent from the sandbox and
	// fails when the script calls it.
	if (script.includes("import")) {
		throw new Error("Workflow script cannot call import. A script coordinates workers. It does not load modules.");
	}
}

/**
 * The isolate's global object. Language builtins stay. Everything that reaches
 * outside the process is either absent or a throwing stub, so a script that
 * gets past the text guard still fails with the name of what it tried.
 */
interface WorkerOptions {
	agentType?: unknown;
	schema?: unknown;
	label?: unknown;
	isolation?: unknown;
	/** Set by parallel() and pipeline(). A soft worker returns null instead of throwing. */
	soft?: boolean;
}

function callHash(prompt: string, agentType: string, schema: unknown, args: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify([prompt, agentType, schema ?? null, args ?? null]))
		.digest("hex");
}

/**
 * One child, through the delegation runtime and nowhere else. The default
 * agent type is the read-only built-in, so a script has to name another type
 * to edit.
 */
function schemaContradiction(schema: unknown): string | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	const record = schema as { required?: unknown; additionalProperties?: unknown; properties?: unknown };
	if (record.additionalProperties === false && Array.isArray(record.required)) {
		const properties = record.properties && typeof record.properties === "object" ? record.properties : {};
		const missing = record.required.find((key) => typeof key === "string" && !(key in properties));
		if (typeof missing === "string") {
			return `schema requires "${missing}" but additionalProperties: false leaves it out`;
		}
	}
	return undefined;
}

function matchesSchema(value: unknown, schema: unknown): string | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	const record = schema as { type?: unknown; required?: unknown };
	if (record.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) return "expected an object";
		if (Array.isArray(record.required)) {
			for (const key of record.required) {
				if (typeof key === "string" && !(key in (value as Record<string, unknown>)))
					return `missing required "${key}"`;
			}
		}
	}
	return undefined;
}

function parseWorkerOutput(output: string, schema: unknown): { value: unknown } | { failure: string } {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start === -1 || end <= start) return { failure: "no JSON object in the worker output" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start, end + 1));
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
	const mismatch = matchesSchema(parsed, schema);
	return mismatch ? { failure: mismatch } : { value: parsed };
}

async function startWorker(
	options: DelegationRuntimeOptions,
	calls: WorkflowCallRecord[],
	args: unknown,
	prompt: string,
	workerOptions: WorkerOptions = {},
	replay: Replay = () => undefined,
	phases?: { title: string; calls: number }[],
): Promise<unknown> {
	if (typeof prompt !== "string" || prompt.length === 0) {
		throw new Error("worker() requires a non-empty prompt.");
	}
	if (!workerOptions.soft) enforceRunCallLimit(calls, 1);
	const agentType = typeof workerOptions.agentType === "string" ? workerOptions.agentType : "explore";
	const contradiction = schemaContradiction(workerOptions.schema);
	if (contradiction) throw new Error(`worker() schema is contradictory: ${contradiction}`);
	const current = phases?.at(-1);
	if (current) current.calls += 1;
	const reused = replay(prompt, agentType, workerOptions.schema);
	if (reused !== undefined) {
		calls.push({
			order: calls.length + 1,
			agentType,
			prompt,
			hash: callHash(prompt, agentType, workerOptions.schema, args),
			value: reused,
		});
		return reused;
	}
	const isolation = workerOptions.isolation === "worktree" ? "worktree" : "shared-read";
	const workspace: ChildWorkspaceRequest = { isolation, ownedPaths: [] };
	try {
		const started = await runDelegation(options, agentType, prompt, { workspace, background: true });
		const handleId = started.handleId;
		if (!handleId) throw new Error(`worker() started "${agentType}" without a handle.`);
		const result = await retrieveDelegationResult(options, handleId, agentType);
		let output: unknown = result.output;
		if (workerOptions.schema) {
			const parsed = parseWorkerOutput(result.output, workerOptions.schema);
			if ("failure" in parsed) {
				await options.childRunRegistry?.sendInput(
					handleId,
					`Your previous output failed the schema: ${parsed.failure}. Return one JSON object and nothing else.`,
				);
				const retried = await retrieveDelegationResult(options, handleId, agentType);
				const second = parseWorkerOutput(retried.output, workerOptions.schema);
				if ("failure" in second)
					throw new Error(`worker() output failed the schema after one follow-up: ${second.failure}`);
				output = second.value;
			} else {
				output = parsed.value;
			}
		}
		// The child has finished its one task. Closing the run keeps the recorded
		// result and frees the concurrency slot for the next batch.
		options.childRunRegistry?.close(handleId);
		calls.push({
			order: calls.length + 1,
			agentType,
			prompt,
			hash: callHash(prompt, agentType, workerOptions.schema, args),
			value: output,
		});
		return output;
	} catch (error) {
		// A worker inside a fan-out is one slot. A worker the script awaits
		// directly still throws, which is why this only swallows the error when
		// the caller passed `soft`.
		if (!workerOptions.soft) throw error;
		calls.push({
			order: calls.length + 1,
			agentType,
			prompt,
			hash: callHash(prompt, agentType, workerOptions.schema, args),
			failed: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

const FANOUT_LIMIT = 256;
const RUN_CALL_LIMIT = 100;
const RUN_CALL_WARNING = 25;

function enforceRunCallLimit(calls: readonly WorkflowCallRecord[], adding: number): void {
	const next = calls.length + adding;
	if (next > RUN_CALL_LIMIT) {
		throw new Error(`worker() would start call ${next}. A workflow run stops at ${RUN_CALL_LIMIT}.`);
	}
}

/** A worker that throws becomes a null slot. The other slots still return. */
async function settle(calls: readonly Promise<unknown>[]): Promise<unknown[]> {
	return Promise.all(
		calls.map((call) =>
			call.then(
				(value) => value,
				() => null,
			),
		),
	);
}

/**
 * A child holds its concurrency slot until the registry closes the run, and a
 * workflow does not close runs mid-script. So a fan-out starts at most as many
 * workers at once as the session allows, and waits for that batch to finish
 * before starting the next. One worker failing does not stop the next batch.
 */
async function inBatches(
	options: DelegationRuntimeOptions,
	count: number,
	start: (index: number) => Promise<unknown>,
): Promise<unknown[]> {
	const width =
		options.maxConcurrentChildren && options.maxConcurrentChildren > 0 ? options.maxConcurrentChildren : count;
	const results: unknown[] = new Array(count);
	for (let begin = 0; begin < count; begin += width) {
		const end = Math.min(begin + width, count);
		const batch = await settle(Array.from({ length: end - begin }, (_, offset) => start(begin + offset)));
		for (let index = 0; index < batch.length; index += 1) results[begin + index] = batch[index];
	}
	return results;
}

function parallel(
	calls: WorkflowCallRecord[],
	args: unknown,
	options: DelegationRuntimeOptions,
	prompts: unknown,
	replay: Replay,
	phases: { title: string; calls: number }[],
): Promise<unknown[]> {
	if (!Array.isArray(prompts)) throw new Error("parallel() requires a list of prompts.");
	if (prompts.length > FANOUT_LIMIT) {
		throw new Error(`parallel() was given ${prompts.length} prompts. The limit is ${FANOUT_LIMIT}.`);
	}
	enforceRunCallLimit(calls, prompts.length);
	return inBatches(options, prompts.length, (index) =>
		startWorker(options, calls, args, String(prompts[index]), { soft: true }, replay, phases),
	);
}

function pipeline(
	calls: WorkflowCallRecord[],
	args: unknown,
	options: DelegationRuntimeOptions,
	items: unknown,
	fn: unknown,
	replay: Replay,
	phases: { title: string; calls: number }[],
): Promise<unknown[]> {
	if (!Array.isArray(items)) throw new Error("pipeline() requires a list of items.");
	if (typeof fn !== "function") throw new Error("pipeline() requires a function from an item to a prompt.");
	if (items.length > FANOUT_LIMIT) {
		throw new Error(`pipeline() was given ${items.length} items. The limit is ${FANOUT_LIMIT}.`);
	}
	enforceRunCallLimit(calls, items.length);
	return settle(
		items.map((item) => {
			const prompt = (fn as (item: unknown) => unknown)(item);
			return startWorker(
				options,
				calls,
				args,
				typeof prompt === "string" ? prompt : String(prompt),
				{ soft: true },
				replay,
				phases,
			);
		}),
	);
}

function throwOn(name: string): never {
	throw new Error(`Workflow script cannot call ${name}. Pass time and randomness in through args.`);
}

type Replay = (prompt: string, agentType: string, schema: unknown) => unknown;

function sandbox(
	args: unknown,
	calls: WorkflowCallRecord[],
	options: DelegationRuntimeOptions,
	replay: Replay = () => undefined,
	phases: { title: string; calls: number }[] = [],
): vm.Context {
	const blocked = (name: string) => () => throwOn(name);
	const context = vm.createContext({
		Object,
		Array,
		String,
		Number,
		Boolean,
		Math: { ...Math, random: blocked("Math.random") },
		JSON,
		Promise,
		args,
		worker: (prompt: string, workerOptions?: WorkerOptions) =>
			startWorker(options, calls, args, prompt, workerOptions, replay, phases),
		phase: (title: unknown) => {
			phases.push({ title: typeof title === "string" && title ? title : "phase", calls: 0 });
		},
		parallel: (prompts: unknown) => parallel(calls, args, options, prompts, replay, phases),
		pipeline: (items: unknown, fn: unknown) => pipeline(calls, args, options, items, fn, replay, phases),
		Date: class extends Date {
			constructor(...input: unknown[]) {
				if (input.length === 0) throwOn("new Date");
				super(...(input as ConstructorParameters<typeof Date>));
			}
			static override now(): number {
				return throwOn("Date.now");
			}
		},
		fetch: blocked("fetch"),
	});
	return context;
}

function resumePath(options: DelegationRuntimeOptions, runId: string | undefined): string | undefined {
	const dir = options.getParentSessionDir?.();
	if (!dir || !runId) return undefined;
	return join(dir, "delegations", runId, "calls.json");
}

function loadResume(path: string | undefined): WorkflowCallRecord[] {
	if (!path) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { calls?: WorkflowCallRecord[] };
		return Array.isArray(parsed.calls) ? parsed.calls : [];
	} catch {
		return [];
	}
}

function saveResume(path: string | undefined, calls: readonly WorkflowCallRecord[]): void {
	if (!path) return;
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ calls }));
}

export async function runWorkflow(
	options: DelegationRuntimeOptions,
	script: string,
	request: WorkflowRunRequest = {},
): Promise<WorkflowRunResult> {
	guard(script);
	const path = resumePath(options, request.runId);
	const previous = loadResume(path);
	const calls: WorkflowCallRecord[] = [];
	const phases: { title: string; calls: number }[] = [];
	let replay = 0;
	const context = sandbox(
		request.args,
		calls,
		options,
		(prompt, agentType, schema) => {
			const prior = previous[replay];
			const hash = callHash(prompt, agentType, schema, request.args);
			if (prior && !prior.failed && prior.hash === hash && replay === calls.length) {
				replay += 1;
				return prior.value;
			}
			previous.length = 0;
			return undefined;
		},
		phases,
	);
	const value: unknown = await vm.runInContext(`(async () => {\n${script}\n})()`, context);
	saveResume(path, calls);
	const warnings =
		calls.length > RUN_CALL_WARNING
			? [`${calls.length} calls. A workflow past ${RUN_CALL_WARNING} calls is hard to resume.`]
			: [];
	return { value, calls, phases, warnings };
}
