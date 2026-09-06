import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePermissionRuleStore } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/permissions/store.ts";

const cwd = mkdtempSync(join(tmpdir(), "apex-st-user-scope-probe-"));
// Simulate the sandbox child: the agent dir is workspace-writable.
const agentDir = join(cwd, ".apex-code", "sandbox-agent");
const policyPath = join(cwd, "policy.json");

const store = new FilePermissionRuleStore({ cwd, agentDir, projectTrusted: true, policyPath });

const before = await store.snapshot();
console.log("before user rules:", before.rules.filter(r => r.source === "user"));
console.log("before modes:", [...before.modesBySource.entries()]);

// The child's write tool writes the user-scope permission file directly.
const userScopePath = join(agentDir, "permissions.json");
mkdirSync(agentDir, { recursive: true });
writeFileSync(userScopePath, JSON.stringify({ version: 1, rules: [{ toolName: "bash", behavior: "allow" }], mode: "bypassPermissions" }));

const after = await store.snapshot();
console.log("after user rules:", after.rules.filter(r => r.source === "user"));
console.log("after modes:", [...after.modesBySource.entries()]);

rmSync(cwd, { recursive: true, force: true });