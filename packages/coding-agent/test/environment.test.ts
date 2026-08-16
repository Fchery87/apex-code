import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	APEX_ENVIRONMENT_VARIABLES,
	getApexEnvironment,
	getApexEnvironmentSpecs,
	setApexEnvironment,
	setApexSubprocessEnvironment,
} from "../src/core/environment.ts";

afterEach(() => vi.restoreAllMocks());

describe("Apex environment compatibility", () => {
	it("rejects unclassified Apex-owned legacy literals in production", () => {
		const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
		const allowed = new Set(APEX_ENVIRONMENT_VARIABLES.map(([, legacy]) => legacy));
		const findings: string[] = [];
		for (const path of globSync("src/**/*.ts", { cwd: packageRoot, absolute: true })) {
			if (path.replaceAll("\\", "/").endsWith("core/environment.ts")) continue;
			const source = readFileSync(path, "utf8");
			for (const match of source.matchAll(/\bPI_[A-Z0-9_]+\b/g)) {
				if (allowed.has(match[0])) findings.push(`${relative(packageRoot, path)}:${match[0]}`);
			}
		}
		expect(findings).toEqual([]);
	});

	it("classifies every owned legacy name exactly once", () => {
		expect(getApexEnvironmentSpecs().map((entry) => entry.legacy)).toEqual(
			APEX_ENVIRONMENT_VARIABLES.map(([, legacy]) => legacy),
		);
		expect(new Set(getApexEnvironmentSpecs().map((entry) => entry.canonical)).size).toBe(
			APEX_ENVIRONMENT_VARIABLES.length,
		);
	});
	it.each(APEX_ENVIRONMENT_VARIABLES)("prefers %s over %s", (canonical, legacy) => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(getApexEnvironment(canonical, { [canonical]: "apex", [legacy]: "pi" })).toBe("apex");
		expect(error).toHaveBeenCalledTimes(1);
	});
	it("supports legacy-only reads and warns once", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const env = { PI_OFFLINE: "1" };
		expect(getApexEnvironment("APEX_CODE_OFFLINE", env)).toBe("1");
		expect(getApexEnvironment("APEX_CODE_OFFLINE", env)).toBe("1");
		expect(error).toHaveBeenCalledTimes(1);
	});
	it("internal writes and subprocess metadata export canonical and compatibility names without warnings", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const env: NodeJS.ProcessEnv = {};
		setApexEnvironment("APEX_CODE_CODING_AGENT", "true", env);
		setApexSubprocessEnvironment(env, { APEX_CODE_SESSION_ID: "session", APEX_CODE_MODEL: "model" });
		expect(env).toMatchObject({
			APEX_CODE_CODING_AGENT: "true",
			PI_CODING_AGENT: "true",
			APEX_CODE_SESSION_ID: "session",
			PI_SESSION_ID: "session",
			APEX_CODE_MODEL: "model",
			PI_MODEL: "model",
		});
		expect(error).not.toHaveBeenCalled();
	});
});
