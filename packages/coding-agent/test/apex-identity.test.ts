import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir, PACKAGE_NAME } from "../src/config.ts";

describe("Apex Code identity", () => {
	it("uses Apex package, command, and global state names", () => {
		expect(PACKAGE_NAME).toBe("apex-code");
		expect(APP_NAME).toBe("apex-code");
		expect(CONFIG_DIR_NAME).toBe(".apex-code");
		expect(ENV_AGENT_DIR).toBe("APEX_CODE_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("APEX_CODE_CODING_AGENT_SESSION_DIR");
		expect(getAgentDir()).toMatch(/[\\/]\.apex-code[\\/]agent$/);
		expect(getAgentDir()).not.toMatch(/[\\/]\.pi[\\/]/);
	});

	it("packages and builds only Apex-owned identities", () => {
		const codingAgent = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
		const agentCore = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../agent/package.json"), "utf8"));
		const binaryScript = readFileSync(resolve(import.meta.dirname, "../../../scripts/build-binaries.sh"), "utf8");

		expect(codingAgent.name).toBe("apex-code");
		expect(codingAgent.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(codingAgent.bin).toEqual({ "apex-code": "dist/cli.js" });
		expect(agentCore.name).toBe("apex-code-agent-core");
		// sync-versions.js keeps the two Apex-owned packages lockstep versioned
		// (scripts/sync-versions.test.mjs), so the dependency range and the
		// core's own version always equal the CLI's own version -- asserted
		// against each other, not a hardcoded literal that goes stale on every
		// release (task 12.15 caught this: it broke on the first real bump).
		expect(codingAgent.dependencies["apex-code-agent-core"]).toBe(codingAgent.version);
		expect(agentCore.version).toBe(codingAgent.version);
		expect(binaryScript).toContain("apex-code-$platform.tar.gz");
		expect(binaryScript).toContain("apex-code-$platform.zip");
	});
});
