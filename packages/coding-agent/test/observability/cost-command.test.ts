import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCostTable, parseCostArgs, runCostCommand } from "../../src/cli/cost-command.ts";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SqliteUsagePerformanceStore } from "../../src/core/usage-performance-store.ts";
import { main } from "../../src/main.ts";

function scratchDir(label: string): string {
	const dir = join(tmpdir(), `apex-cost-command-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("parseCostArgs", () => {
	it("defaults to grouping by model with no time filter", () => {
		expect(parseCostArgs([])).toEqual({ dimension: "model" });
	});

	it("accepts --by session and --by role", () => {
		expect(parseCostArgs(["--by", "session"])).toEqual({ dimension: "session" });
		expect(parseCostArgs(["--by", "role"])).toEqual({ dimension: "role" });
	});

	it("rejects an unknown --by value", () => {
		const result = parseCostArgs(["--by", "provider"]);
		expect("error" in result).toBe(true);
	});

	it("parses --since as a relative duration", () => {
		const before = Date.now();
		const result = parseCostArgs(["--since", "7d"]);
		expect("error" in result).toBe(false);
		if ("error" in result) throw new Error("unreachable");
		expect(result.sinceMs).toBeDefined();
		const expected = before - 7 * 24 * 60 * 60 * 1000;
		expect(Math.abs((result.sinceMs ?? 0) - expected)).toBeLessThan(2000);
	});

	it("parses --since as an ISO date", () => {
		const result = parseCostArgs(["--since", "2026-01-01T00:00:00.000Z"]);
		expect("error" in result).toBe(false);
		if ("error" in result) throw new Error("unreachable");
		expect(result.sinceMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
	});

	it("rejects an unparseable --since value", () => {
		const result = parseCostArgs(["--since", "not-a-date"]);
		expect("error" in result).toBe(true);
	});
});

describe("formatCostTable", () => {
	it("renders an empty ledger as a plain message, not an empty table", () => {
		expect(formatCostTable([], "model")).toContain("No usage recorded");
	});

	it("renders rows with cost, average latency, and sample count", () => {
		const table = formatCostTable(
			[{ key: "acme/acme-large", cost: 1.5, sampleCount: 3, ttftMsTotal: 300, generationMsTotal: 900 }],
			"model",
		);
		expect(table).toContain("acme/acme-large");
		expect(table).toContain("1.500");
		expect(table).toContain("3");
	});
});

describe("runCostCommand end to end", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	it("reads a seeded ledger and prints a grouped-by-model table", async () => {
		const agentDir = scratchDir("e2e");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const store = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"), "session-1");
		cleanups.push(() => store.close());
		await store.record({
			timestamp: Date.now(),
			provider: "acme",
			model: "acme-large",
			role: "default",
			outcome: "success",
			ttftMs: 100,
			generationMs: 400,
			cost: 0.25,
		});

		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: string) => {
			logs.push(line);
		});

		await runCostCommand(agentDir, ["--by", "role"]);

		const output = logs.join("\n");
		expect(output).toContain("default");
		expect(output).toContain("0.250");
	});
});

describe("apex-code cost wired at the top-level CLI dispatch", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	it('main(["cost"]) reads the real agent directory\'s ledger and prints a table, without starting a session', async () => {
		const agentDir = scratchDir("cli-dispatch");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const seeded = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"), "session-cli");
		await seeded.record({
			timestamp: Date.now(),
			provider: "acme",
			model: "acme-large",
			outcome: "success",
			ttftMs: 10,
			generationMs: 20,
			cost: 1.234,
		});
		seeded.close();

		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		cleanups.push(() => {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
		});

		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: string) => {
			logs.push(String(line));
		});

		await main(["cost"]);

		expect(logs.join("\n")).toContain("1.234");
	});
});
