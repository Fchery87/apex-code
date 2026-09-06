# Execution wiring audit

Reviewed checkout `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`, committed 2026-09-04T21:11:42-04:00. The request named September 3, but this is an audit of the current checkout, not a historical September 3 snapshot. No application code, tracked tests, or tracked configuration changed. All command probes used temporary directories and the project's Node/tsx environment. No full suite ran in this worker.

## How execution is wired

- The normal public CLI parses arguments, resolves host-only sandbox policy, and launches the whole session in a supervised child. Every subprocess inside that child inherits its OS boundary. Explicit full access requires a warning and confirmation. See `packages/coding-agent/src/cli.ts:33-106`.
- `main()` resolves project trust and builds services, then passes a real permission gate into session creation. ACP supplies a responder bridge. Normal RPC uses the same path, and `RpcClient` defaults to `dist/cli.js`, not the alternative RPC entry. See `packages/coding-agent/src/main.ts:764-825`, `873-908`, and `packages/coding-agent/src/modes/rpc/rpc-client.ts:81-98`.
- SDK `createAgentSession()` does not create an OS sandbox. It defaults to `SettingsManager.create()`, which trusts project settings by default, and leaves the permission gate optional. This is explicit compatibility behavior, not proof that the CLI lacks a gate. See `packages/coding-agent/src/core/sdk.ts:237-252`, `615-627`; `packages/coding-agent/src/core/settings-manager.ts:588-606`; `packages/coding-agent/src/core/agent-session.ts:278-285`.
- Tool calls run extension interception, declarative hook decisions, then the canonical permission gate. Hooks can block but cannot turn a denied call into an allowed one. See `packages/coding-agent/src/core/agent-session.ts:674-730`.
- LSP services start configured servers eagerly after resource reload. Their configuration comes through trust-filtered settings. They spawn in the session process environment rather than through the bash tool gate. This is configured executable code approved by project trust and contained by the CLI child, not a separately approved tool call. See `packages/coding-agent/src/core/agent-session-services.ts:218-224`, `258-280`; `packages/coding-agent/src/core/lsp/pool.ts:69-77`, `134-145`; `packages/coding-agent/src/core/lsp/client.ts:204-209`.
- MCP has separate configuration loading. Every SDK session creates its own MCP runtime, including delegated sessions, then warms eager servers. Tool invocations carry a real MCP contract, but startup happens outside that tool call path. See `packages/coding-agent/src/core/sdk.ts:325-330`, `550-582`, `634`; `packages/coding-agent/src/core/mcp/contract.ts:82-95`.
- Verification and formatting load named policies from separate user/project settings. Project policies are absent when untrusted. Their execution path calls the argv executor directly. Background bash, by contrast, remains a bash tool invocation with the same gate and session-owned handle registry. See `packages/coding-agent/src/core/agent-session.ts:2353-2412`; `packages/coding-agent/src/core/tools/bash.ts:576-624`.
- Delegation reuses the parent's trust state, resource loader and model runtime. It derives permission rules live, restricts capabilities, and provides no responder to a child's ask. See `packages/coding-agent/src/core/sdk.ts:529-582`; `packages/coding-agent/src/core/delegation/ceiling.ts:32-42`; `packages/coding-agent/src/core/permissions/store.ts:277-302`.

## Confirmed findings

### E1. High: untrusted project MCP commands run at session construction

Actor and prerequisites: a repository author can add `.mcp.json` with an eager stdio server. The victim only needs to open a session in that repository. No model tool call or tool permission approval is needed.

Evidence:

- `packages/coding-agent/src/core/trust-manager.ts:30-38`, `185-193` omits `.mcp.json` from trust-requiring resources.
- `packages/coding-agent/src/core/sdk.ts:325-330` calls `createMcpRuntime(cwd)` without the settings trust decision; line `634` starts warming unconditionally.
- `packages/coding-agent/src/core/mcp/runtime.ts:25-34` loads the project file. `packages/coding-agent/src/core/mcp/config.ts:175-183` merges it regardless of trust and lets project entries replace global names.
- `packages/coding-agent/src/core/mcp/server-manager.ts:129-139` acquires eager connections. `packages/coding-agent/src/core/mcp/connector.ts:34-45`, `72-74` starts arbitrary configured commands or HTTP transport. Stdio receives the current process environment.

Consequence: rejecting project trust does not prevent repository-supplied process execution. The normal CLI sandbox still limits that process, but the workspace can be changed and allowed network destinations remain reachable. An SDK embedding or unsandboxed entry executes with its host authority. Project name overrides can replace an already configured global server. Delegated read-only sessions also warm MCP even when their active tools exclude MCP.

Narrow remedy: pass explicit project trust into MCP configuration assembly and omit the project source while untrusted. Include `.mcp.json` in trust-resource detection. Bind eager connection startup to approved configuration and allowed execution authority. Test public session creation with `projectTrusted:false`, an eager project command, and `tools:[]`; the command must not run.

Check: the real session probe used `SettingsManager.create(..., {projectTrusted:false})`, no tools, no model turn, and an eager MCP command that wrote a marker. It exited 0 and printed `projectTrusted= false mcpCommandExecuted= true`. See checks below.

### E2. High: verifier and formatter policies ignore deny/ask and session permission limits

Actor and prerequisites: a trusted project, global policy, or extension calls a configured verifier/formatter. A project may configure `boundary:"post-turn"` to trigger execution without an explicit verification request. Users who set a policy to deny or run a plan-only session reasonably expect no command execution.

Evidence:

- `packages/coding-agent/src/core/policy-loader.ts:165-190` parses and stores `permission`, defaulting to ask.
- `packages/coding-agent/src/core/agent-session.ts:2372-2383`, `2392-2408` select policies and call executors without the session gate or responder.
- `packages/coding-agent/src/core/agent-session.ts:2451-2453` runs the first post-turn verifier directly.
- `packages/coding-agent/src/core/verification-lifecycle.ts:112-124` calls `runPolicyCommand()` without permission evaluation.
- `packages/coding-agent/src/core/policy-executor.ts:125-180` checks cancellation and lexical cwd containment, then spawns. It never checks `permission`.
- `docs/specs/2026-09-01-configured-verification-and-formatting.md:113-129`, `171` requires a policy permission ceiling, session-mode limits, canonical classification, and denied-policy non-execution.

Consequence: even `permission:"deny"` executes a real command and can return verified. The CLI OS boundary remains in force, but no tool permission rule or plan-mode restriction caps this path. Trusted repository commands can run at each turn boundary despite policy denial.

Narrow remedy: route every named policy invocation through one canonical exec permission boundary before spawning. Deny must execute nothing; ask must use an available responder or fail closed. Apply the same path to explicit verification, post-turn verification, and formatters. Add tests at the public session boundary for both deny and plan mode.

Check: a parsed user verification policy with `permission:"deny"` ran Node and returned `outcome:"verified"` and `status:"passed"`, exit 0. This was a lifecycle-boundary probe, with the public caller chain confirmed statically.

### E3. High: formatter scope is reporting only, not enforced

Actor and prerequisites: a configured formatter executes project code that writes outside `declaredPaths` or through a symlink. This includes accidental broad formatter commands; malicious code is not required.

Evidence:

- `packages/coding-agent/src/core/formatter-lifecycle.ts:201-220` rejects unsafe strings only.
- Lines `223-245` take snapshots, run the unrestricted policy command, then classify mutations.
- Lines `251-272` retain the process status, even when undeclared or escaped writes are found. No prevention or failure result follows.
- `packages/coding-agent/src/core/policy-executor.ts:148-180` uses lexical cwd containment, not realpath containment or a per-policy filesystem restriction.
- `docs/specs/2026-09-01-configured-verification-and-formatting.md:123-129` requires refusal of symlink escapes and undeclared writes.

Consequence: declared paths are not an execution limit. A formatter declared for one file can overwrite another workspace file, report `passed`, and leave that mutation in place. The broad CLI workspace mount cannot enforce narrower formatter scope. Outside-workspace writes remain constrained by the CLI sandbox, but not by these policy APIs themselves.

Narrow remedy: execute against a restricted per-policy filesystem or an isolated worktree and promote only declared, validated changes. At minimum, do not report passed when mutation violations occur; document that detection is not prevention until true confinement exists. Do not automatically revert user changes in the live workspace.

Check: the native formatter probe declared only `allowed.txt`, wrote `unrelated.txt`, and returned `formatterStatus= passed undeclaredPaths= [ 'unrelated.txt' ] undeclaredWritePersisted= true`.

### E4. High: raw argv classification can silently skip the entire CLI sandbox

Actor and prerequisites: an operator or caller passes argument text that equals a metadata flag as another flag's value or after `--`. This need not be an intentional sandbox opt-out. No `danger-full-access` flag or confirmation is required.

Evidence:

- `packages/coding-agent/src/core/sandbox/cli-launch.ts:17-21` scans raw argv for metadata/help tokens without parsing their roles.
- `packages/coding-agent/src/cli/args.ts:100-112`, `128-132` treats tokens after `--` as messages and consumes prompt values verbatim.
- `packages/coding-agent/src/cli.ts:45-54` uses the raw classifier for both confirmation and sandbox startup. Lines `110-116` call `main()` directly when it returns false.

Consequence: `--append-system-prompt --help --mode rpc` or `--system-prompt --version --mode rpc` selects an ordinary runtime according to `parseArgs`, but skips containment according to the startup classifier. Adding a valid headless permission mode satisfies the separate permission startup check. This removes OS restrictions for all session subprocesses, not only bash.

Narrow remedy: classify startup from the same parsed command representation used by main. Metadata tokens inside values or positional text must never alter the execution boundary. Add public CLI tests with harmless outside-workspace markers for these argv shapes.

Check: the native parser/classifier probe exited 0. It reported `requiresSandboxedChild:false` and `mode:"rpc"`, with no parsed help/version field and no diagnostics, for both examples. A full CLI marker probe is recorded separately below.

## Tradeoffs and hardening gaps, not additional confirmed exploits

- The exported `apex-code/rpc-entry` starts `main()` directly and does not run the CLI supervisor or full-access confirmation. Evidence: `packages/coding-agent/package.json:20-22`, `packages/coding-agent/src/rpc-entry.ts:1-14`. No default internal caller was found; the normal `RpcClient` uses `cli.js`. Treat the alternative entry as an unsafe embedding boundary. Route it through supervised CLI startup or state that callers must provide OS isolation.
- SDK sessions intentionally default to trusted project settings and no permission gate. This compatibility choice is hazardous for an embedding that accepts arbitrary workspaces. Offer a safe constructor/profile or make this obligation prominent. The MCP trust failure above remains a defect even when the embedder explicitly passes `projectTrusted:false`.
- Command hooks run before the tool gate in the session process. They have trusted settings as their approval boundary. Timeouts call `child.kill()` only, not the shared process-tree helper, at `packages/coding-agent/src/core/hooks/command-handler.ts:62-79`. A shell descendant can outlive the failed hook. This is a confirmed cleanup weakness by source inspection, not a reproduced sandbox escape. Use process-group termination and bounded cleanup.
- HTTP hooks call `response.text()` without a byte limit at `packages/coding-agent/src/core/hooks/http-handler.ts:22-31`. A configured endpoint can consume excessive memory. The request timeout exists but is not an output cap. Add a streaming byte ceiling.
- MCP manager timeout uses `Promise.race()` and does not cancel or close a late connector at `packages/coding-agent/src/core/mcp/server-manager.ts:60-90`. `closeAll()` closes only stored connections at `153-166`. Late or failed startup cleanup needs a real process test; no persistent-process exploit was demonstrated here.

## Positive controls

- The universal gate evaluates final extension-mutated input. A nonblocking extension result cannot bypass it. Declarative hooks can only restrict. See `packages/coding-agent/src/core/agent-session.ts:692-728` and `packages/coding-agent/src/core/hooks/runtime.ts:39-54`.
- Project settings are omitted when untrusted. The extension bootstrap explicitly clears trust before loading user/global and temporary CLI extensions. See `packages/coding-agent/src/core/settings-manager.ts:619-621` and `packages/coding-agent/src/core/resource-loader.ts:380-403`.
- Normal noninteractive CLI sessions require an explicit permission mode. See `packages/coding-agent/src/core/permissions/startup.ts:20-33` and `packages/coding-agent/src/main.ts:661-669`.
- Background bash launches still use the bash contract. Registry cleanup calls the shared process-tree killer for active handles. See `packages/coding-agent/src/core/tools/background-shell.ts:91-106`.
- Child delegation refuses missing parent gates, shares the parent's trust state, derives live rules, and cannot persist child approvals into parent policy files. See `packages/coding-agent/src/core/sdk.ts:529-562` and `packages/coding-agent/src/core/permissions/store.ts:287-302`.
- Policy commands use structured argv with `shell:false`, explicit timeouts, output bounds, and shared tree cleanup. These controls are useful but do not replace permission evaluation or scope confinement.

## CI, release, and dependency coverage

A separate read-only worker inspected this area. Full evidence and exact focused test output are in [execution-ci.md](execution-ci.md). Two confirmed findings need action:

1. The release verifier checks registry bytes against the same registry's hashes rather than the exact smoke-tested local tarball. It checks provenance metadata presence without validating a signed attestation. No compromised release was observed.
2. The inherited `build-binaries.yml` still triggers `v*` tags and retains separate privileged release jobs. It expects obsolete `pi-*` artifacts while the producer creates `apex-code-*`. Current mismatch prevents this path from completing normally, but does not justify retaining an independent release authority.

The worker ran 26 focused workflow/verifier tests successfully. Its production dependency audit returned zero known vulnerabilities at the time of this audit. The parent owns broader type/lint/dependency/full-suite results; this report does not claim those passed. CI configuration, release rules, and current tests can all pass while missing these cross-entrypoint invariants.

## Checks and retained probes

Probe files and raw successful outputs are retained under `execution-probes/`. They contain only synthetic temp paths and harmless marker commands, not credentials. Imports run through the project tooling with `node --import tsx`; no dependency was installed. The scripts use temp workspaces and do not modify repository state.

- `git log -1 --format="%H %cI %s"`: exit 0. Output is `execution-probes/head.log`.
- `node --import tsx /tmp/apex-execution-audit-9jrqki6o/argv-probe.mts`: exit 0. Retained script and `argv.log` show both parser mismatches.
- `node --import tsx /tmp/apex-execution-audit-9jrqki6o/mcp-probe.mts`: exit 0. Output in `mcp.log` is `trustRequiringResources= false projectTrusted= false` and `projectMcpCommandExecuted= true`.
- `node --import tsx /tmp/apex-execution-audit-9jrqki6o/probe.mts`: corrected run exit 0. Output in `combined.log` proves actual session creation executes untrusted MCP with no tools or model turn. It also repeats the denied verifier proof. Its formatter rerun wrote identical bytes to an existing scratch marker, so it correctly reported no new mutation; use the fresh standalone result for E3.
- `node --import tsx /tmp/apex-execution-audit-9jrqki6o/policy-probe.mts`: corrected run exit 0. Output in `policy.log` proves the denied verifier and undeclared formatter write. Initial probe attempts failed due my wrong cleanup method and an invalid test field `mutatesFiles`; these were probe errors, not product failures. Corrected scripts are retained.

No browser test, live ACP client, published package installation, or full SDK sandbox integration test ran here. The final CLI probe unexpectedly attempted a real Google provider request using inherited environment entries despite `--offline`; the provider rejected them with API_KEY_INVALID. The marker was created before that failure. No credential value appears in the retained output. RPC alternative-entry consumer impact and MCP late-start cleanup remain bounded static observations. Findings E1-E4 do not require those unverified paths.

### Corrected full CLI marker probe

Command: `node --import tsx /tmp/apex-cli-classifier-qenbfdhn/launch.mts`. The retained `execution-probes/launch.mts` sets a fresh temporary HOME, agent directory, and workspace, then imports the real source CLI with `--print --no-session --permission-mode plan --no-approve --system-prompt --version --offline hello`. An eager project MCP command targets a harmless marker in a sibling temporary path outside the workspace. The command exited 1. The outside-workspace marker existed: `true`. Exact combined output:

```text
Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.
{"error":{"message":"{\n  \"error\": {\n    \"code\": 400,\n    \"message\": \"API key not valid. Please pass a valid API key.\",\n    \"status\": \"INVALID_ARGUMENT\",\n    \"details\": [\n      {\n        \"@type\": \"type.googleapis.com/google.rpc.ErrorInfo\",\n        \"reason\": \"API_KEY_INVALID\",\n        \"domain\": \"googleapis.com\",\n        \"metadata\": {\n          \"service\": \"generativelanguage.googleapis.com\"\n        }\n      },\n      {\n        \"@type\": \"type.googleapis.com/google.rpc.LocalizedMessage\",\n        \"locale\": \"en-US\",\n        \"message\": \"API key not valid. Please pass a valid API key.\"\n      }\n    ]\n  }\n}\n","code":400,"status":"Bad Request"}}
```

Raw output and marker observation are retained in `execution-probes/cli-corrected.log`. The first attempt used the invalid flag `--no-trust`; it also wrote the marker before rejecting that flag. Only the corrected attempt above is used for the valid-argv CLI result.
