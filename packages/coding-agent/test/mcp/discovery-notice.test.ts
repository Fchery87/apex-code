import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { createTestSession, type TestSessionContext } from "../utilities.ts";

let context: TestSessionContext | undefined;
afterEach(() => {
	context?.cleanup();
	context = undefined;
});

describe("MCP discovery notice (HR.14)", () => {
	it("emits one event naming the servers started to list their tools", async () => {
		context = await createTestSession();
		const events: AgentSessionEvent[] = [];
		context.session.subscribe((event) => events.push(event));
		context.session.reportMcpDiscovery(["docs", "wiki"]);
		expect(events.filter((event) => event.type === "mcp_discovery_started")).toEqual([
			{ type: "mcp_discovery_started", servers: ["docs", "wiki"] },
		]);
		expect(context.session.getMcpDiscoveryStarted()).toEqual(["docs", "wiki"]);
	});

	it("emits nothing when no server had to be started", async () => {
		context = await createTestSession();
		const events: AgentSessionEvent[] = [];
		context.session.subscribe((event) => events.push(event));
		context.session.reportMcpDiscovery([]);
		expect(events.some((event) => event.type === "mcp_discovery_started")).toBe(false);
	});
});
