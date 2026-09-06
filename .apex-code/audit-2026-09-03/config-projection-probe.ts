import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxedCliLaunch } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/cli-launch.ts";
import { FilePermissionRuleStore } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/permissions/store.ts";
const scratch = mkdtempSync(join(tmpdir(), "apex-audit-config-"));
const oldCwd = process.cwd();
try {
 process.chdir(scratch);
 const hostAgent = join(scratch, "host-agent");
 const workspace = join(scratch, "workspace");
 mkdirSync(hostAgent, {recursive:true}); mkdirSync(workspace);
 writeFileSync(join(hostAgent, "permissions.json"), JSON.stringify({version:1,rules:[{toolName:"bash",behavior:"deny"}]}));
 const policyPath = join(scratch, "managed-policy.json");
 writeFileSync(policyPath, JSON.stringify({version:1,rules:[{toolName:"write",behavior:"deny"}]}));
 const launch = buildSandboxedCliLaunch({workspace,command:process.execPath,args:[],environment:{APEX_CODE_CODING_AGENT_DIR:hostAgent,APEX_CODE_POLICY_PATH:policyPath}});
 const host = await new FilePermissionRuleStore({cwd:workspace, agentDir:hostAgent, policyPath}).snapshot();
 const child = await new FilePermissionRuleStore({cwd:workspace, agentDir:launch.environment.APEX_CODE_CODING_AGENT_DIR, policyPath:join(scratch,"missing-default-policy")}).snapshot();
 console.log(JSON.stringify({hostRules:host.rules,childRules:child.rules,hostErrors:host.errors,childErrors:child.errors,childPolicyOverride:launch.environment.APEX_CODE_POLICY_PATH ?? null,projectedReadOnlyFiles:launch.readOnlyFiles,projectedReadOnlyPaths:launch.readOnlyPaths},null,2));
} finally {process.chdir(oldCwd); rmSync(scratch,{recursive:true,force:true});}
