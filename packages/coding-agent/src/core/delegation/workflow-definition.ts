import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const WORKFLOW_DEFINITION_MAX_BYTES = 64 * 1024;
export const WORKFLOW_STEP_LIMIT = 100;
const identifier = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
const pointer = Type.String({ maxLength: 1024, pattern: "^(?:/(?:[^~/]|~[01])*)*$" });
const referenceSchema = Type.Object(
	{ from: identifier, pointer: Type.Optional(pointer) },
	{ additionalProperties: false },
);
const stepSchema = Type.Object(
	{
		id: identifier,
		needs: Type.Optional(Type.Array(identifier, { maxItems: WORKFLOW_STEP_LIMIT, uniqueItems: true })),
		prompt: Type.Union([
			Type.String({ minLength: 1 }),
			Type.Array(Type.Union([Type.String(), referenceSchema]), { minItems: 1, maxItems: 100 }),
		]),
		phase: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		agentType: Type.Optional(identifier),
		schema: Type.Optional(Type.Unknown()),
		isolation: Type.Optional(Type.Union([Type.Literal("shared-read"), Type.Literal("worktree")])),
	},
	{ additionalProperties: false },
);
export const workflowDefinitionSchema = Type.Object(
	{
		version: Type.Literal(1),
		steps: Type.Array(stepSchema, { minItems: 1, maxItems: WORKFLOW_STEP_LIMIT }),
		output: referenceSchema,
		concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
		failurePolicy: Type.Optional(Type.Union([Type.Literal("stop"), Type.Literal("continue-independent")])),
	},
	{ additionalProperties: false },
);
export type WorkflowDefinition = Static<typeof workflowDefinitionSchema>;
export type WorkflowStep = WorkflowDefinition["steps"][number];
export type WorkflowReference = Static<typeof referenceSchema>;

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function workflowDefinitionDigest(definition: unknown): string {
	return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
	if (typeof input === "string")
		throw new Error("Workflow JavaScript is disabled. Supply a versioned JSON definition.");
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(input);
	} catch {
		throw new Error("Workflow must be JSON data.");
	}
	if (!encoded || Buffer.byteLength(encoded) > WORKFLOW_DEFINITION_MAX_BYTES)
		throw new Error("Workflow exceeds the 64 KB document limit.");
	if (!Check(workflowDefinitionSchema, input))
		throw new Error(
			"Invalid workflow definition. Require version 1, 1 to 100 steps, safe identifiers, JSON pointers and positive limits.",
		);
	const definition = input;
	const steps = new Map<string, WorkflowStep>();
	for (const step of definition.steps) {
		if (step.id === "args" || steps.has(step.id))
			throw new Error(`Duplicate or reserved workflow step identifier "${step.id}".`);
		steps.set(step.id, step);
	}
	const ancestors = new Map<string, Set<string>>();
	const visiting = new Set<string>();
	const visit = (id: string): Set<string> => {
		const cached = ancestors.get(id);
		if (cached) return cached;
		if (visiting.has(id)) throw new Error(`Workflow dependency cycle at "${id}".`);
		const step = steps.get(id);
		if (!step) throw new Error(`Unknown workflow dependency "${id}".`);
		visiting.add(id);
		const found = new Set<string>();
		for (const need of step.needs ?? []) {
			found.add(need);
			for (const ancestor of visit(need)) found.add(ancestor);
		}
		visiting.delete(id);
		ancestors.set(id, found);
		return found;
	};
	for (const step of definition.steps) {
		const ancestry = visit(step.id);
		if (Array.isArray(step.prompt))
			for (const fragment of step.prompt) {
				if (typeof fragment !== "string" && fragment.from !== "args" && !ancestry.has(fragment.from)) {
					throw new Error(`Workflow reference "${fragment.from}" is outside dependency ancestry of "${step.id}".`);
				}
			}
	}
	if (definition.output.from !== "args" && !steps.has(definition.output.from))
		throw new Error(`Unknown workflow output reference "${definition.output.from}".`);
	return definition;
}

export function selectWorkflowReference(
	reference: WorkflowReference,
	args: unknown,
	outputs: ReadonlyMap<string, unknown>,
): unknown {
	if (reference.from !== "args" && !outputs.has(reference.from))
		throw new Error(`Unavailable workflow reference "${reference.from}".`);
	let value = reference.from === "args" ? args : outputs.get(reference.from);
	for (const token of (reference.pointer ?? "").split("/").slice(1)) {
		const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
			throw new Error(`Missing workflow reference property "${key}".`);
		value = Reflect.get(value, key);
	}
	return value;
}

export function renderWorkflowPrompt(step: WorkflowStep, args: unknown, outputs: ReadonlyMap<string, unknown>): string {
	if (typeof step.prompt === "string") return step.prompt;
	return step.prompt
		.map((fragment) => {
			if (typeof fragment === "string") return fragment;
			const value = selectWorkflowReference(fragment, args, outputs);
			return typeof value === "string" ? value : JSON.stringify(value);
		})
		.join("");
}
