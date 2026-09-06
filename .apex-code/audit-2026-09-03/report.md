# Apex Code security and execution audit

## Scope and verdict

Requested reference date: September 3, 2026. Audited checkout: `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`, committed September 4. The forked application source is identical to `49e1f18efcf3dcbb130c4b108d9606fb3e0404a6`, the last commit before September 4 in the repository's local timezone. Tests and documentation differ. Public documentation retrieved during this audit is date-qualified separately.

This was a read-only audit, not a repair or security certification. I did not change application code. Scratch scripts, reports, and output are under `.apex-code/audit-2026-09-03/`. I did not access the prohibited source tree.

**Verdict:** the main Linux sandbox has real containment and its existing tests pass, but Apex is not ready to claim that project trust, permission rules, and the sandbox form one reliable security boundary. Independent paths bypass each control. A malicious repository can run eager MCP code before trust, grant itself permissions through project files, and exploit host supervisor services under stated prerequisites. Some ordinary argument shapes skip the outer sandbox entirely. These are wiring defects, not missing polish.

No finding merits an unconditional Critical rating. The High findings need a malicious repository, a permissive mode, a released credential host, a matching lower-priority rule, or another stated prerequisite. The detailed reports preserve those conditions.

## Architecture reviewed

Project trust decides whether repository configuration may load. Tool rules decide whether a proposed tool call may run. The OS sandbox limits the resulting process tree. These controls are separate. One cannot replace another.

The normal CLI starts a supervisor, creates a Linux Bubblewrap or macOS Seatbelt child, and starts the agent inside it. The session gate evaluates tool calls after extension and declarative-hook changes. The supervisor owns network, credential, terminal, and command-escalation channels. Because sandbox descendants can request those services, every channel needs structured input validation and safe host-side execution.

## Priority findings

### 1. Untrusted repositories cross the trust boundary

**High, confirmed.** Repository permission files are not trust-gated. `.apex-code/permissions.json` can select `bypassPermissions` or add Bash grants even when the user rejects project trust. A write-capable `acceptEdits` session can then write `.apex-code/permissions.local.json` and grant itself Bash on the next permission snapshot. Managed policy still wins when it matches.

Evidence: `packages/coding-agent/src/core/trust-manager.ts:30-38,185-193`, `src/main.ts:772-777,825-833`, `src/core/permissions/store.ts:164-166,198-231`, and the real store/write probe in `permissions.md`.

**High, confirmed.** Eager project MCP ignores the same trust decision. Creating a session with `projectTrusted:false`, no tools, and no model turn ran a repository-supplied MCP command. The normal CLI sandbox limits that process only if startup actually selected the sandbox.

Evidence: `src/core/sdk.ts:325-330,634`, `src/core/mcp/runtime.ts:25-34`, `src/core/mcp/connector.ts:34-45,72-74`, and `execution-probes/mcp.log`.

Remedy: make the resolved trust decision an input to every project-source loader. Exclude project permissions and `.mcp.json` while untrusted. Store authorization state outside model-writable roots. If repository restrictions should apply before trust, load deny-only data through a separate representation.

### 2. Raw CLI arguments can bypass the OS sandbox

**High, confirmed.** `requiresSandboxedChild()` scans raw tokens for `--help` and `--version` without knowing whether a token is an option value or message text. The real parser treats those tokens differently. Examples include `--append-system-prompt --help --mode rpc` and `--print -- --help`. The public launcher then calls `main()` on the host without the full-access warning.

Evidence: `packages/coding-agent/src/core/sandbox/cli-launch.ts:17-21`, `src/cli/args.ts:100-112,128-132`, `src/cli.ts:45-54,110-116`, and `execution-probes/argv.log`. A corrected public CLI probe used `--system-prompt --version --mode rpc --permission-mode plan --no-approve --offline hello`. An eager project MCP command wrote a sibling marker outside the workspace. The CLI later exited 1 only because the deliberately invalid provider key caused a 400 response. This proves the session started outside the intended workspace boundary without trust approval. See `execution-probes/cli-corrected.log`.

Remedy: parse once. Base metadata behavior, full-access confirmation, and sandbox selection on the same typed command result. Add CLI integration cases where option values and positional messages contain metadata-looking strings.

### 3. Permission matching does not authorize the same operation that executes

**High, confirmed.** Path permission matching does not strip the `@` prefix that execution strips. `read("@secret.txt")` bypassed a deny on `secret.txt` and read the denied file. Lexical path matching also lets a symlink alias bypass a target-specific deny.

Evidence: `src/core/tools/path-permission.ts:24-36`, `src/utils/paths.ts:102-121`, `src/core/tools/path-utils.ts:40-49`, and `permissions-probe.log`.

**High, confirmed.** Scoped Bash denies use an all-segments match. A policy deny for `touch:*` blocks `touch denied`, but stops matching `echo ok; touch denied` or a redirected variant. A lower blanket allow then wins. Unsupported grammar has the same fail-open effect for deny matching.

Evidence: `src/core/tools/bash.ts:128-138`, `src/core/permissions/rules.ts:50-51,84-85`, and `permissions-edge-probe.log`.

**High, confirmed.** Exact Bash grants collapse whitespace inside quoted strings. An approval for a harmless `sh -c` string also matched a version with a quoted newline that executed `touch marker`. The safe temp probe confirmed the original made no marker and the altered input did.

Evidence: `src/core/tools/bash.ts:79-99,147-153` and `permissions-bash-exact-probe.log`.

**Medium, confirmed.** Generated path grants keep minimatch metacharacters. Approving a literal `*.txt` can approve sibling `.txt` files.

Remedy: resolve and normalize one operation object before authorization, then execute that object. Deny semantics must detect any prohibited shell segment. Unknown grammar must not let a lower allow erase a restriction. Preserve exact quoted bytes. Represent exact paths separately from globs and authorize canonical targets, including safe handling for non-existent write targets.

### 4. Verification and formatting bypass the permission gate

**High, confirmed.** The policy loader parses `permission: "deny"` and `"ask"`, but the verifier and formatter call `runPolicyCommand()` directly. A verifier marked deny executed and returned `verified`. Plan mode and normal tool rules do not cap this path.

**High, confirmed.** Formatter `declaredPaths` are audit output, not enforcement. A formatter declared for `allowed.txt` wrote `unrelated.txt`, returned `passed`, reported the undeclared path, and left the write in place.

Evidence: `src/core/policy-loader.ts:165-190`, `src/core/verification-lifecycle.ts:112-124`, `src/core/formatter-lifecycle.ts:223-272`, `src/core/policy-executor.ts:125-180`, and `execution-probes/policy.log`.

Remedy: put every configured command behind the canonical exec authorization path. Deny must spawn nothing. Ask without a responder must fail closed. Run formatters in a restricted filesystem or isolated worktree, then promote only declared changes. Until then, scope violations must not return `passed`.

### 5. Supervisor services turn sandbox data into host authority

**High, confirmed, conditional on credential release.** Host Git credential lookup runs `git credential fill` without a supervisor-owned `cwd`. Git reads writable repository config, so `credential.helper = !command` executes on the host after the user releases a reachable host.

**High, confirmed, conditional on an already authorized host.** The Git credential protocol is newline-delimited, but `protocol` is not validated. A value containing `https\nhost=other.invalid\n\n` changes the credential identity after authorization checked a different host.

Evidence: `src/core/sandbox/rpc/git-credential-proxy.ts:97-109`, `git-credential-helper.ts:141-166`, and `sandbox-probes/boundaries.log`.

**High, confirmed.** The supervisor writes fixed state paths inside the writable workspace and follows symlinks. A symlinked `terminal-handoff` made cleanup truncate and write `resume\n` to a file outside the workspace as the host user.

Evidence: `src/core/sandbox/terminal-handoff.ts:82-88,150-151`, related startup writers listed in `sandbox.md`, and `sandbox-probes/boundaries.log`.

Remedy: run Git from a private, non-repository directory with repository-discovery and config-injection environment removed. Validate each protocol field before serialization and authorize the final structured identity. Move all supervisor-owned mutable state outside child-writable paths. Use no-follow, descriptor-relative operations where a projection is unavoidable.

### 6. Host permission configuration is lost at sandbox launch

**High, confirmed.** Sandbox startup repoints `APEX_CODE_CODING_AGENT_DIR` to workspace `.apex-code/sandbox-agent` and drops `APEX_CODE_POLICY_PATH`. Host user permission files are not projected or merged. The default `/etc/apex-code/policy.json` remains visible, so the custom-policy loss requires no equivalent policy at that standard path.

Evidence: `src/core/sandbox/cli-launch.ts:146-228,281-343`, `src/main.ts:825-833`, and `config-projection-probe.log`.

Remedy: resolve authorization inputs in the supervisor. Pass the child an immutable policy snapshot or a narrow read-only projection. Keep approval persistence outside workspace state.

### 7. Release verification does not prove the published bytes were tested

**High, confirmed release-integrity defect.** The smoke gate tests local packed tarballs, but the workflow publishes again from package directories. Post-publication verification compares downloaded bytes only with registry-supplied hashes. It checks attestation metadata fields, not the signed attestation, subject digest, or workflow identity. This is not evidence that a release was compromised.

Evidence: `scripts/apex/packed-product-surface.mjs:197-203,283-303`, `.github/workflows/release.yml:175-198,232-241`, and `scripts/apex/verify-published-release.mjs:49-104,154-155`.

Remedy: preserve local digests, publish the exact tested tarballs, compare registry bytes with those digests, and verify signed provenance identity.

## Platform and hardening findings

- **High, static macOS defect.** `profile.sb` lives in attacker-writable workspace state between write and `sandbox-exec -f`. An existing child can race a later launch or escalation. This was not tested on macOS.
- **Medium, confirmed Linux defect.** The supervisor creates the command-escalation socket but does not mount it into the Bubblewrap child. The live child reported `ESCALATION_SOCKET_EXISTS=false`. This fails closed.
- **Medium, static macOS contract drift.** Escalation recursively creates a full session backend, retaining network and credential channels that ADR 0024 says the second child must not receive. This was not tested on macOS.
- **Medium, confirmed overprojection.** Directory projections mount their parent. A skill root at `~/.agents/skills` exposes `~/.agents`, including siblings.
- **Medium, confirmed release wiring defect.** The inherited `build-binaries.yml` still triggers on `v*` and retains separate release-write jobs. It currently expects obsolete `pi-*` artifacts while the producer makes `apex-code-*`, so it is broken rather than safely disabled.
- **High practical impact, documented tradeoff.** Linux read-only root binding still exposes pathname Unix sockets outside hidden `/home`. A real Bubblewrap child with `allowedHosts:[]` reached a synthetic host Unix service. ADR 0005 explicitly excludes arbitrary Unix-socket isolation, so this is not labeled an undocumented sandbox escape. Hide host runtime/socket directories or narrow the root projection before claiming deny-all egress.

Other bounded concerns, including PowerShell's reuse of Bash grammar, hook descendant cleanup, MCP connection cancellation, HTTP hook response limits, proxy connection limits, and home directories outside `/home`, remain hypotheses or hardening gaps. The component reports give evidence and suggested tests without promoting them to confirmed exploits.

## Comparison with public Claude Code and Codex documentation

The strongest historical anchor is Anthropic's public `CHANGELOG.md` commit `b3f0e501b79fe5cfc8c10d18cf3b0b6715c5c2fb`, timestamped September 3, 2026. The former Codex repository sandbox document was removed in January 2026, so the audit could not reconstruct a complete September 3 Codex documentation snapshot. Current pages were fetched September 5 and several OpenAI responses had a September 4 `Last-Modified` header. Treat current-only comparisons as near-date context, not proof of September 3 behavior.

Useful differences:

- Current Claude docs say Bash sandboxing is off by default and can warn then continue unsandboxed unless `failIfUnavailable` is enabled. Apex's normal CLI fails if its OS backend is unavailable. That is a stronger Apex default.
- Current Codex docs describe local command sandboxing and network-off defaults. They also gate project `.codex/` config, rules, hooks, and MCP on project trust. Apex currently fails that trust property for permissions and MCP.
- Current Codex docs describe Linux Bubblewrap plus seccomp, native Windows modes, hash-based hook trust, and beta permission profiles. Apex uses Bubblewrap on Linux and Seatbelt on macOS, refuses Windows, and has no equivalent hook hash-trust mechanism in this review.
- Claude and Codex both document that command sandbox/network rules do not cover every extension, MCP, browser, hosted-service, or authentication path. Apex should document the same separation, but its eager MCP and supervisor-channel issues are implementation defects rather than mere exclusions.
- Claude documents explicit sandbox fallback behavior. Codex documents refusal for unsupported mandatory profiles. Apex's backend-unavailable path fails closed, but its raw-argv classifier and alternate SDK/RPC embedding paths weaken that guarantee.

See `public-comparison.md` for the source register, immutable anchors, response hashes, and exact evidence limits.

## Controls that worked

- The Linux backend uses user, PID, and network namespaces plus a private `/dev` and `/proc`.
- Backend absence and invalid writable roots stop startup rather than silently falling back.
- The ordinary tool gate runs after extension and hook input changes. Missing responders and malformed permission files fail closed.
- Managed policy outranks lower sources when it matches. Plan's mutation floor survives managed allows.
- Child delegation derives live parent rules, enforces capability ceilings, and has no approval responder.
- Policy command spawning uses structured argv, `shell:false`, timeouts, bounded output, and process-tree cleanup.
- Credential mutation RPC uses private socket directories, bounded frames, connection controls, and host-side locking.
- The intended release workflow pins actions and has frozen-package, dependency, SBOM, license, and packed-install gates.

## Verification results

Commands ran from the repository root. Logs contain exact output.

| Check | Result |
| --- | --- |
| `npx tsgo --noEmit` | Exit 0 |
| `npm run check:docs` | Exit 0, lifecycle validation passed |
| `npx biome check --error-on-warnings .` | Exit 0, 1 fixable info in `test/tools/edit-diagnostics.test.ts:250`; no fixes applied |
| `npm audit --omit=dev --json` | Exit 0, 0 known production vulnerabilities, 411 dependencies reported |
| pinned dependencies, TS import boundaries, scrubber types, shrinkwrap, install lock, browser smoke | Exit 0 |
| `test/sandbox/linux-backend.test.ts` | 19 passed |
| complete `test/sandbox` directory | 229 passed, 8 skipped |
| focused permission tests | 120 passed |
| focused workflow/release tests | 26 passed |
| `npm test` | Exit 1. The final coding-agent run had 3,427 passes, 58 skips, 2 failures in `startup-session-name.test.ts` |
| rerun of `test/startup-session-name.test.ts` | Exit 0, 2 passed |

The full-run failures both observed a spawned process with `code:null` and `signal:null`, consistent with that test's timeout path. The narrow rerun passed in 11.87 seconds. This makes the broad run flaky or load-sensitive, not green. I do not claim `npm test` passed.

## Repair order

1. Fix raw CLI classification and trust-gate both permissions and MCP. These decide whether any later control runs.
2. Move authorization and supervisor state out of workspace-writable paths. Fix the Git host boundary and credential field validation.
3. Unify authorization and execution representations for paths, Bash, verifiers, and formatters.
4. Repair Linux escalation projection, then implement and test the smaller macOS escalation path and private Seatbelt profiles on macOS.
5. Bind release publication to the tested bytes and remove the second release authority.
6. Add adversarial tests at public entrypoints. Unit matcher tests alone missed the cross-layer failures above.

This order follows complete mediation and least authority. First make sure every operation crosses the intended boundary. Then make the boundary decide on the exact operation that will execute. Finally reduce the authority behind each approved channel.

## Artifact index

- `permissions.md`: permission flow, seven confirmed findings, probes, and 120-test output
- `sandbox.md`: Linux/macOS flow, supervisor findings, accepted limits, and live Bubblewrap probes
- `execution-wiring.md`: CLI, SDK, MCP, hook, verification, formatter, and delegation paths
- `execution-ci.md`: release and dependency review
- `public-comparison.md`: date-qualified Claude Code and Codex comparison and source register
- `config-projection.md`: host-to-child policy projection defect
- `commands.json` and `*.log`: command manifest and raw validation output
- `permissions-*.mts`, `sandbox-probes/`, `execution-probes/`: retained harmless reproductions
