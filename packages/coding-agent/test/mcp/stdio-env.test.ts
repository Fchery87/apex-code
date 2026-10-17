import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStdioEnvironment, connectMcpServer } from "../../src/core/mcp/connector.ts";
import type { McpServerConfig } from "../../src/core/mcp/types.ts";

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined): void {
	if (!(name in saved)) saved[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	setEnv("HR5_TEST_TOKEN", "abc123");
	setEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-reach-servers");
});

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) setEnv(name, value);
	for (const name of Object.keys(saved)) delete saved[name];
});

describe("MCP stdio environment (HR.5)", () => {
	it("does not pass the parent's provider keys to a server", () => {
		const env = buildStdioEnvironment({});
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("keeps the SDK default safe set, such as PATH", () => {
		const env = buildStdioEnvironment({});
		expect(env.PATH).toBeDefined();
	});

	it("resolves a configured $VAR reference from the parent environment", () => {
		const env = buildStdioEnvironment({ TOKEN: "$HR5_TEST_TOKEN" });
		expect(env.TOKEN).toBe("abc123");
	});

	it("resolves the braced reference form as well as the bare one", () => {
		const braced = `$${"{HR5_TEST_TOKEN}"}`;
		const env = buildStdioEnvironment({ TOKEN: braced });
		expect(env.TOKEN).toBe("abc123");
	});

	it("treats $$ as a literal dollar sign", () => {
		const env = buildStdioEnvironment({ PRICE: "$$5" });
		expect(env.PRICE).toBe("$5");
	});

	it("omits a reference to a variable that is not set", () => {
		const env = buildStdioEnvironment({ TOKEN: "$HR5_NOT_SET_ANYWHERE" });
		expect(env.TOKEN).toBeUndefined();
	});

	it("names the env reference syntax when a stdio server cannot start", async () => {
		const server: McpServerConfig = {
			name: "broken",
			transport: { kind: "stdio", command: "/nonexistent/apex-hr5-server", args: [], env: {}, cwd: undefined },
			capabilities: new Set(),
			lifecycle: "lazy",
			idleTimeoutMinutes: 10,
		};
		await expect(connectMcpServer(server)).rejects.toThrow(/"NAME": "\$NAME"/);
	});
});
