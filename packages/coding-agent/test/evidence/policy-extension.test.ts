import { describe, expect, it } from "vitest";
import { createEvidencePolicyExtension } from "../../src/core/evidence-policy.ts";

const records = [
	{
		id: "record-1",
		sessionId: "session-1",
		toolName: "test",
		timestamp: "2026-08-16T00:00:00.000Z",
		facts: { kind: "test" as const, cwd: "/scratch", executable: "npm", argv: ["test"], exitCode: 1 },
	},
];

describe("evidence policy extension", () => {
	it("consumes durable evidence read-only after source capture without changing a tool result", async () => {
		let handler:
			| ((
					event: { toolName: string; toolCallId: string; isError: boolean },
					ctx: { sessionManager: { getEvidenceRecords(): typeof records } },
			  ) => Promise<unknown>)
			| undefined;
		const observed: unknown[] = [];
		const extension = createEvidencePolicyExtension(async (input) => {
			observed.push(input);
		});
		const api = {
			on(event: string, candidate: unknown) {
				if (event === "tool_result" && typeof candidate === "function") {
					handler = candidate as typeof handler;
				}
			},
		};
		extension(api as never);

		const result = await handler!(
			{ toolName: "test", toolCallId: "call-1", isError: true },
			{ sessionManager: { getEvidenceRecords: () => records } },
		);

		expect(result).toBeUndefined();
		expect(observed).toEqual([{ toolName: "test", toolCallId: "call-1", isError: true, records }]);
	});
});
