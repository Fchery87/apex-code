import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveSessionDirectory } from "../src/experimental/server.ts";

afterEach(() => vi.unstubAllEnvs());

describe("experimental server session directory", () => {
	test("uses the experimental directory under the configured agent directory by default", () => {
		const agentDir = join(tmpdir(), "apex-code-agent-config");
		vi.stubEnv("APEX_CODE_CODING_AGENT_DIR", agentDir);

		expect(resolveSessionDirectory()).toBe(join(agentDir, "experimental", "sessions"));
	});

	test("resolves an explicit relative directory from the current working directory", () => {
		vi.stubEnv("APEX_CODE_CODING_AGENT_DIR", join(tmpdir(), "apex-code-agent-config"));

		expect(resolveSessionDirectory("relative/sessions")).toBe(resolve("relative/sessions"));
	});

	test("expands a tilde in an explicit directory", () => {
		expect(resolveSessionDirectory("~/custom-sessions")).toBe(resolve(homedir(), "custom-sessions"));
	});
});
