import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";

/**
 * Pins the public-surface decision in ADR 0027: the inherited `AgentHarness`
 * scaffold is not Apex Code's public API. The module stays in the tree (and
 * its own scaffold test drives it relatively); only the re-export is gone.
 */
describe("apex-code-agent-core public surface", () => {
	it("does not export the AgentHarness scaffold", async () => {
		expect((publicApi as Record<string, unknown>).AgentHarness).toBeUndefined();
		expect((publicApi as Record<string, unknown>).HarnessNotImplemented).toBeUndefined();
	});

	it("still exports the live agent core", () => {
		expect(publicApi.Agent).toBeDefined();
	});
});
