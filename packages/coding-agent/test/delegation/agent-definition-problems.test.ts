import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentDefinitionDiagnostics, createAgentDefinitionResolver } from "../../src/core/delegation/agents.ts";

let scratch: string;
let agentDir: string;
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "apex-agent-problems-"));
	agentDir = join(scratch, "agent");
	await mkdir(join(agentDir, "agents"), { recursive: true });
});
afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<void> {
	await writeFile(join(agentDir, "agents", name), content);
}

function resolver() {
	return createAgentDefinitionResolver({ cwd: scratch, agentDir, isProjectTrusted: () => false });
}

describe("agent definitions: tools as a string, and visible problems (HR.11)", () => {
	it("accepts tools as a comma-separated string", () => {
		return write("pair.md", "---\nname: pair\ndescription: two tools\ntools: read, grep\n---\nGo.").then(() => {
			expect(resolver()("pair")?.tools).toEqual(["read", "grep"]);
		});
	});

	it("still accepts tools as a YAML list", () => {
		return write("list.md", "---\nname: list\ndescription: list form\ntools:\n  - read\n---\nGo.").then(() => {
			expect(resolver()("list")?.tools).toEqual(["read"]);
		});
	});

	it("reports a definition with no description, naming the file and the field", async () => {
		await write("broken.md", "---\nname: broken\ntools:\n  - read\n---\nGo.");
		const r = resolver();
		expect(r("broken")).toBeUndefined();
		const problem = r.problems().find((entry) => entry.path.endsWith("broken.md"));
		expect(problem).toBeDefined();
		expect(problem?.reason).toMatch(/description/);
	});

	it("reports a tools entry that is not a name", async () => {
		await write("badtools.md", "---\nname: badtools\ndescription: x\ntools:\n  - 42\n---\nGo.");
		const problem = resolver()
			.problems()
			.find((entry) => entry.path.endsWith("badtools.md"));
		expect(problem?.reason).toMatch(/tools/);
	});

	it("a valid definition produces no problem", async () => {
		await write("good.md", "---\nname: good\ndescription: fine\ntools: read\n---\nGo.");
		expect(resolver().problems()).toEqual([]);
	});
});

describe("agent definition problems in /resources (HR.11)", () => {
	it("projects each problem into a warning that names the file", async () => {
		await writeFile(join(agentDir, "agents", "nodesc.md"), "---\nname: nodesc\ntools: read\n---\nGo.");
		const diagnostics = agentDefinitionDiagnostics(resolver());
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.type).toBe("warning");
		expect(diagnostics[0]?.path).toMatch(/nodesc\.md$/);
		expect(diagnostics[0]?.message).toMatch(/missing description/);
	});

	it("returns nothing for a resolver with no problems or none that expose them", () => {
		expect(agentDefinitionDiagnostics(() => undefined)).toEqual([]);
	});
});
