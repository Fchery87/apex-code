import { describe, expect, it } from "vitest";
import { parseWorkflowOutput, validateWorkflowOutputSchema } from "../../src/core/delegation/workflow-output.ts";

describe("workflow output boundary", () => {
	it("parses scalar, array, and object JSON documents", () => {
		expect(parseWorkflowOutput("42", { type: "number" })).toBe(42);
		expect(parseWorkflowOutput("[1,2]", { type: "array", items: { type: "number" } })).toEqual([1, 2]);
		expect(
			parseWorkflowOutput('{"ok":true}', {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			}),
		).toEqual({ ok: true });
	});
	it("rejects trailing prose and malformed JSON", () => {
		expect(() => parseWorkflowOutput('{"ok":true}\nDone', { type: "object" })).toThrow(/JSON|trailing/i);
		expect(() => parseWorkflowOutput("{bad", { type: "object" })).toThrow(/JSON/i);
	});
	it("rejects type, required, extra, enum, and nested violations", () => {
		const schema = {
			type: "object",
			properties: {
				count: { type: "integer", minimum: 1 },
				kind: { enum: ["ok"] },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["count", "kind"],
			additionalProperties: false,
		};
		expect(() => parseWorkflowOutput('{"count":"1","kind":"ok"}', schema)).toThrow(/integer|type/i);
		expect(() => parseWorkflowOutput('{"kind":"ok"}', schema)).toThrow(/required/i);
		expect(() => parseWorkflowOutput('{"count":1,"kind":"ok","extra":true}', schema)).toThrow(/additional|extra/i);
		expect(() => parseWorkflowOutput('{"count":1,"kind":"bad"}', schema)).toThrow(/enum/i);
		expect(() => parseWorkflowOutput('{"count":1,"kind":"ok","tags":[2]}', schema)).toThrow(/string|type/i);
	});
	it("rejects unsupported keywords and schema limits before output validation", () => {
		expect(() => validateWorkflowOutputSchema({ type: "object", oneOf: [] })).toThrow(/keyword/i);
		expect(() => validateWorkflowOutputSchema({ $ref: "https://example.com/schema" })).toThrow(
			/ref|remote|unsupported/i,
		);
		expect(() => parseWorkflowOutput("1", { type: "number", minimum: 2 })).toThrow(/minimum/i);
		expect(() => parseWorkflowOutput('"abc"', { type: "string", maxLength: 2 })).toThrow(/length/i);
		expect(() => parseWorkflowOutput("[1,2,3]", { type: "array", maxItems: 2 })).toThrow(/items/i);
	});
	it("enforces document size and nesting bounds", () => {
		expect(() => parseWorkflowOutput("x".repeat(70_000), {})).toThrow(/64 KB|size/i);
		expect(() => parseWorkflowOutput(`${"[".repeat(40)}0${"]".repeat(40)}`, {})).toThrow(/depth/i);
	});
	it("accepts negative numeric bounds", () => {
		expect(parseWorkflowOutput("-3", { type: "number", minimum: -5, maximum: -1 })).toBe(-3);
	});
	it.each([
		{ minimum: 5, maximum: 1 },
		{ minLength: 5, maxLength: 1 },
		{ minItems: 5, maxItems: 1 },
	])("rejects contradictory bounds before parsing output: %j", (schema) => {
		expect(() => validateWorkflowOutputSchema(schema)).toThrow(/bound|limit|minimum|maximum/i);
	});
	it.each(["minLength", "maxLength", "minItems", "maxItems"])("requires integer %s limits", (key) => {
		expect(() => validateWorkflowOutputSchema({ [key]: 1.5 })).toThrow(/limit|integer/i);
	});
	it("compares enum objects by JSON value instead of property order", () => {
		expect(parseWorkflowOutput('{"b":[2],"a":1}', { enum: [{ a: 1, b: [2] }] })).toEqual({ a: 1, b: [2] });
		expect(() => parseWorkflowOutput('{"b":[3],"a":1}', { enum: [{ a: 1, b: [2] }] })).toThrow(/enum/i);
	});
	it("counts Unicode code points for string limits", () => {
		expect(parseWorkflowOutput('"😀"', { type: "string", minLength: 1, maxLength: 1 })).toBe("😀");
		expect(() => parseWorkflowOutput('"😀"', { type: "string", minLength: 2 })).toThrow(/length/i);
	});
});
