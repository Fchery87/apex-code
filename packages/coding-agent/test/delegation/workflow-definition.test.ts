import { describe, expect, it } from "vitest";
import { parseWorkflowDefinition, selectWorkflowReference } from "../../src/core/delegation/workflow-definition.ts";

const worker = { id: "scan", prompt: "Scan files" };
const graph = () => ({ version: 1, steps: [worker], output: { from: "scan" } });

describe("workflow definition boundary", () => {
	it("accepts a versioned graph and inert prompt text", () => {
		const value = { ...graph(), steps: [{ id: "scan", prompt: "process.exit(1)" }] };
		expect(parseWorkflowDefinition(value).steps[0].prompt).toBe("process.exit(1)");
	});
	it("refuses executable bodies, invalid versions and unknown fields", () => {
		expect(() => parseWorkflowDefinition("return 1")).toThrow(/JavaScript|JSON/);
		expect(() => parseWorkflowDefinition({ ...graph(), version: 2 })).toThrow();
		expect(() => parseWorkflowDefinition({ ...graph(), script: "return 1" })).toThrow();
	});
	it("rejects duplicate IDs, unknown dependencies and cycles before dispatch", () => {
		expect(() => parseWorkflowDefinition({ ...graph(), steps: [worker, worker] })).toThrow(/duplicate/i);
		expect(() => parseWorkflowDefinition({ ...graph(), steps: [{ ...worker, needs: ["missing"] }] })).toThrow(
			/dependency/i,
		);
		expect(() => parseWorkflowDefinition({ ...graph(), steps: [{ ...worker, needs: ["scan"] }] })).toThrow(/cycle/i);
	});
	it("rejects references outside dependency ancestry", () => {
		expect(() =>
			parseWorkflowDefinition({ ...graph(), steps: [worker, { id: "rank", prompt: [{ from: "scan" }] }] }),
		).toThrow(/ancestry|dependenc/i);
		expect(() => parseWorkflowDefinition({ ...graph(), output: { from: "missing" } })).toThrow(/reference/i);
	});
	it("accepts a dependency pipeline and argument references", () => {
		const value = parseWorkflowDefinition({
			version: 1,
			steps: [
				{ id: "scan", prompt: [{ from: "args", pointer: "/path" }] },
				{ id: "rank", needs: ["scan"], phase: "rank", prompt: ["Rank ", { from: "scan", pointer: "/items" }] },
			],
			output: { from: "rank" },
		});
		expect(value.steps).toHaveLength(2);
	});
	it("rejects oversized graphs, unsafe identifiers, invalid pointers and limits", () => {
		expect(() =>
			parseWorkflowDefinition({
				...graph(),
				steps: Array.from({ length: 101 }, (_, n) => ({ id: `s${n}`, prompt: "go" })),
			}),
		).toThrow(/100/);
		expect(() => parseWorkflowDefinition({ ...graph(), steps: [{ ...worker, id: "../x" }] })).toThrow();
		expect(() => parseWorkflowDefinition({ ...graph(), output: { from: "scan", pointer: "/~2bad" } })).toThrow(
			/pointer/i,
		);
		expect(() => parseWorkflowDefinition({ ...graph(), concurrency: 0 })).toThrow();
		expect(() => parseWorkflowDefinition({ ...graph(), steps: [{ ...worker, prompt: "x".repeat(65536) }] })).toThrow(
			/64|bytes/i,
		);
	});
	it("selects own JSON pointer properties without prototype traversal", () => {
		const outputs = new Map<string, unknown>([["scan", { "a/b": [4], "~x": 8 }]]);
		expect(selectWorkflowReference({ from: "scan", pointer: "/a~1b/0" }, {}, outputs)).toBe(4);
		expect(selectWorkflowReference({ from: "args", pointer: "/name" }, { name: "src" }, outputs)).toBe("src");
		expect(() => selectWorkflowReference({ from: "scan", pointer: "/toString" }, {}, outputs)).toThrow(
			/reference|property/i,
		);
	});
});
