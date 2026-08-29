import { describe, expect, it } from "vitest";
import { createMcpToolContract } from "../../src/core/mcp/contract.ts";
import type { McpServerConfig } from "../../src/core/mcp/types.ts";
import { ALL_CAPABILITIES, type Capability } from "../../src/core/tools/contract.ts";

function server(name: string, capabilities?: Capability[]): McpServerConfig {
	return {
		name,
		transport: { kind: "stdio", command: name, args: [], env: {}, cwd: undefined },
		capabilities: capabilities ? new Set(capabilities) : ALL_CAPABILITIES,
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
	};
}

function configOf(...servers: McpServerConfig[]): ReadonlyMap<string, McpServerConfig> {
	return new Map(servers.map((entry) => [entry.name, entry]));
}

const call = (tool: string) => ({ tool, args: {} });

describe("MCP tool contract", () => {
	describe("rule grammar", () => {
		const contract = createMcpToolContract(configOf(server("github"), server("gitlab")));

		it("matches an exact tool rule for that call", () => {
			expect(contract.permission.matches("Mcp(github:create_issue)", call("github:create_issue"))).toBe(true);
		});

		it("does not match an exact tool rule for a different tool", () => {
			expect(contract.permission.matches("Mcp(github:create_issue)", call("github:list_repos"))).toBe(false);
		});

		it("matches a server wildcard for any tool on that server", () => {
			expect(contract.permission.matches("Mcp(github:*)", call("github:create_issue"))).toBe(true);
			expect(contract.permission.matches("Mcp(github:*)", call("github:anything_at_all"))).toBe(true);
		});

		it("does not let one server's wildcard authorize another server", () => {
			expect(contract.permission.matches("Mcp(gitlab:*)", call("github:create_issue"))).toBe(false);
		});

		it("round-trips a concrete call through ruleForCall and matches", () => {
			const params = call("github:create_issue");
			const rule = contract.permission.ruleForCall(params);

			expect(rule).toBe("Mcp(github:create_issue)");
			expect(contract.permission.matches(rule as string, params)).toBe(true);
		});

		it("gives metadata reads their own generalizable rule", () => {
			const search = { search: "issue" };
			const rule = contract.permission.ruleForCall(search);

			expect(rule).toBe("Mcp(metadata)");
			expect(contract.permission.matches(rule as string, search)).toBe(true);
			expect(contract.permission.matches(rule as string, { describe: "github:create_issue" })).toBe(true);
		});

		it("never lets a metadata rule authorize a call", () => {
			expect(contract.permission.matches("Mcp(metadata)", call("github:create_issue"))).toBe(false);
		});

		it("never lets a call rule authorize a metadata read", () => {
			expect(contract.permission.matches("Mcp(github:*)", { search: "issue" })).toBe(false);
		});

		it("rejects a malformed rule instead of matching it", () => {
			expect(contract.permission.matches("Mcp(github)", call("github:create_issue"))).toBe(false);
			expect(contract.permission.matches("github:*", call("github:create_issue"))).toBe(false);
			expect(contract.permission.matches("Mcp(*:*)", call("github:create_issue"))).toBe(false);
		});

		it("renders a rule a person can read in a prompt", () => {
			expect(contract.permission.describe("Mcp(github:*)")).toContain("github");
			expect(contract.permission.describe("Mcp(metadata)")).toMatch(/metadata|search/i);
		});
	});

	describe("capabilities", () => {
		it("carries the union of configured servers, because one proxy tool has one set", () => {
			const contract = createMcpToolContract(configOf(server("a", ["net"]), server("b", ["fs.read"])));

			expect(contract.capabilities).toEqual(new Set(["net", "fs.read"]));
		});

		it("widens to the full set when any server declares nothing", () => {
			const contract = createMcpToolContract(configOf(server("a", ["net"]), server("b")));

			expect(contract.capabilities).toEqual(ALL_CAPABILITIES);
		});

		it("is empty with no servers configured, holding no authority it cannot use", () => {
			expect(createMcpToolContract(configOf()).capabilities.size).toBe(0);
		});
	});

	describe("context behaviour", () => {
		const contract = createMcpToolContract(configOf(server("github")));

		it("is not recoverable, because an MCP call may have side effects", () => {
			expect(contract.context.resultRecoverable).toBe(false);
		});

		it("defers its schema, which is what keeps the prompt affordable", () => {
			expect(contract.context.deferSchema).toBe(true);
		});

		it("asks by default, since a call reaches code this repo does not own", () => {
			expect(contract.permission.defaultBehavior).toBe("ask");
		});

		it("emits no evidence yet, which ADR 0007 governs separately", () => {
			expect(contract.evidence.emits.size).toBe(0);
		});
	});
});
