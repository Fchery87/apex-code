const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const keywords = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"description",
	"title",
]);

type Schema = Record<string, unknown>;
function object(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function schemaBytes(schema: unknown): number {
	return Buffer.byteLength(JSON.stringify(schema) ?? "", "utf8");
}
function validateSchema(schema: unknown, depth = 0): asserts schema is Schema {
	if (!object(schema)) throw new Error("Workflow output schema must be a JSON object.");
	if (depth > MAX_DEPTH) throw new Error("Workflow output schema exceeds the depth limit.");
	if (schemaBytes(schema) > MAX_BYTES) throw new Error("Workflow output schema exceeds the 64 KB size limit.");
	for (const key of Object.keys(schema)) {
		if (key.startsWith("$") || !keywords.has(key))
			throw new Error(`Unsupported workflow output schema keyword "${key}".`);
	}
	if (schema.type !== undefined && (typeof schema.type !== "string" || !types.has(schema.type)))
		throw new Error("Workflow output schema has an unsupported type.");
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0))
		throw new Error("Workflow output enum must be a non-empty array.");
	for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
		const limit = schema[key];
		if (
			limit !== undefined &&
			(typeof limit !== "number" ||
				!Number.isFinite(limit) ||
				(key !== "minimum" && key !== "maximum" && (!Number.isInteger(limit) || limit < 0)))
		)
			throw new Error(`Workflow output schema limit ${key} is invalid.`);
	}
	for (const [lower, upper] of [
		["minimum", "maximum"],
		["minLength", "maxLength"],
		["minItems", "maxItems"],
	]) {
		const minimum = schema[lower];
		const maximum = schema[upper];
		if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum)
			throw new Error(`Workflow output schema bounds ${lower} and ${upper} contradict each other.`);
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string"))
	)
		throw new Error("Workflow output required must be a string array.");
	if (schema.properties !== undefined) {
		if (!object(schema.properties)) throw new Error("Workflow output properties must be an object.");
		for (const child of Object.values(schema.properties)) validateSchema(child, depth + 1);
	}
	if (schema.items !== undefined) validateSchema(schema.items, depth + 1);
	if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
		throw new Error("Workflow output additionalProperties must be boolean.");
	if (schema.type === "object" && schema.required && schema.properties) {
		for (const key of schema.required as string[])
			if (!Object.hasOwn(schema.properties, key))
				throw new Error(`Workflow output required property "${key}" is not defined.`);
	}
}
function equalJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
	if (object(left) && object(right))
		return (
			Object.keys(left).length === Object.keys(right).length &&
			Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && equalJson(value, right[key]))
		);
	return false;
}
function check(value: unknown, schema: Schema, path: string, depth: number): void {
	if (depth > MAX_DEPTH) throw new Error(`Workflow output exceeds the depth limit at ${path}.`);
	if (schema.enum && !(schema.enum as unknown[]).some((candidate) => equalJson(candidate, value)))
		throw new Error(`Workflow output enum mismatch at ${path}.`);
	const type = schema.type;
	const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	if (
		type &&
		actual !== type &&
		!(type === "number" && actual === "number") &&
		!(type === "integer" && typeof value === "number" && Number.isInteger(value))
	)
		throw new Error(`Workflow output type mismatch at ${path}. Expected ${type}.`);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`Workflow output number is not finite at ${path}.`);
		const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
		const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
		if (minimum !== undefined && value < minimum) throw new Error(`Workflow output is below minimum at ${path}.`);
		if (maximum !== undefined && value > maximum) throw new Error(`Workflow output exceeds maximum at ${path}.`);
	}
	if (typeof value === "string") {
		const length = Array.from(value).length;
		const minLength = typeof schema.minLength === "number" ? schema.minLength : undefined;
		const maxLength = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
		if (minLength !== undefined && length < minLength)
			throw new Error(`Workflow output is below minLength at ${path}.`);
		if (maxLength !== undefined && length > maxLength)
			throw new Error(`Workflow output exceeds maxLength at ${path}.`);
	}
	if (Array.isArray(value)) {
		const minItems = typeof schema.minItems === "number" ? schema.minItems : undefined;
		const maxItems = typeof schema.maxItems === "number" ? schema.maxItems : undefined;
		if (minItems !== undefined && value.length < minItems)
			throw new Error(`Workflow output is below minItems at ${path}.`);
		if (maxItems !== undefined && value.length > maxItems)
			throw new Error(`Workflow output exceeds maxItems at ${path}.`);
		if (schema.items) {
			for (const [index, item] of value.entries())
				check(item, schema.items as Schema, `${path}/${index}`, depth + 1);
		} else {
			for (const [index, item] of value.entries()) check(item, {}, `${path}/${index}`, depth + 1);
		}
	}
	if (object(value)) {
		const properties = object(schema.properties) ? schema.properties : {};
		for (const key of (schema.required as string[] | undefined) ?? [])
			if (!Object.hasOwn(value, key))
				throw new Error(`Workflow output required property "${key}" is missing at ${path}.`);
		for (const [key, item] of Object.entries(value)) {
			if (Object.hasOwn(properties, key)) check(item, properties[key] as Schema, `${path}/${key}`, depth + 1);
			else if (schema.additionalProperties === false)
				throw new Error(`Workflow output has an additional property "${key}" at ${path}.`);
			else check(item, {}, `${path}/${key}`, depth + 1);
		}
	}
}
export function validateWorkflowOutputSchema(schema: unknown): asserts schema is Schema {
	validateSchema(schema);
}
export function parseWorkflowOutput(text: string, schema: unknown): unknown {
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("Workflow output exceeds the 64 KB size limit.");
	validateSchema(schema);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Workflow output must be one complete JSON document.");
	}
	check(value, schema, "$", 0);
	return value;
}
