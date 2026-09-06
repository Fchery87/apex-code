# Sandbox/host-service review (HEAD `1964612833cddbf89e4ad61fa0921e8b42f488cc`)

## Scope and method

I read `review-contract.md`, the September 3 report and detailed `sandbox.md` and `config-projection.md`. I inspected the current source at the stated HEAD without touching the prohibited `c-code` tree. This is read-only review; no source edits, installs, network credentials, provider turns, or broad audit launchers were used. The retained audit probes were inspected but not re-run because they execute real launch/backend paths and the contract requires checking side effects; the detailed reports record their harmless scratch setup and exact output. Claims below are checked against current source, not accepted solely from the prior narrative.

## Findings

### Finding 4 / S5 — raw CLI classification can skip the sandbox: **CONFIRMED-STATIC; prior reproduction accepted**

`packages/coding-agent/src/core/sandbox/cli-launch.ts:17-21` classifies raw argv by searching for metadata tokens. The parser in `packages/coding-agent/src/cli/args.ts:100-112,128-132` instead treats `--` tail text and option values as data. The public launcher calls `requiresSandboxedChild()` before entering `main()` (`packages/coding-agent/src/cli.ts:20-58,110-116`). Therefore `--print -- --help` or a system-prompt value containing `--version` can be classified as non-sandbox metadata even though the typed parse is an ordinary session. This is a public-boundary wiring defect, not a unit-helper issue. The prior `sandbox.md` retained probe reports `sandbox:false` and parsed print-mode objects; the full entrypoint turn was assigned elsewhere, so this review does not claim a new live turn.

**Prerequisites / impact:** a user or wrapper supplies these argument shapes; ordinary host-side session, extension, and tool authority follows. A confined child cannot escape merely by nesting the CLI. **Smallest repair:** parse once, then share one typed command result for metadata handling, full-access confirmation, and sandbox selection. **Acceptance test:** invoke the real public CLI in a scratch workspace with metadata-looking positional and option-value text, assert the supervisor/backend is selected, and separately assert genuine `--help`/`--version` behavior.

### Finding 9 / S4 — macOS Seatbelt profile is child-writable: **CONFIRMED-STATIC, UNVERIFIED RACE**

`packages/coding-agent/src/core/sandbox/macos-backend.ts:285-286` writes `profile.sb` below the workspace state directory, while `:301-304` passes that path to `sandbox-exec`; escalation reuses the backend/profile path (`:206-218`). The workspace is writable by the child. Thus profile substitution between write and read is structurally possible on macOS. I did not run macOS or demonstrate timing. The prior audit’s characterization as a static race is supported; it is not proof of a successful exploit.

**Prerequisites / impact:** macOS and a repository/descendant able to modify the shared path during launch; a successful race can widen the next child’s Seatbelt policy. **Repair:** private supervisor-owned per-launch directory outside all child-writable roots, with no path reuse. **Acceptance test:** macOS integration test attempts pre-existing symlink, replacement, and concurrent substitution and verifies the launched child retains the intended profile.

### Finding 10 / S6 — Linux escalation socket omitted from child projection: **CONFIRMED-STATIC; prior probe reproduced**

`packages/coding-agent/src/core/sandbox/linux-backend.ts:225-235` starts the escalation proxy and `:270` provides `APEX_COMMAND_ESCALATION_PATH`, but the socket mounts at `:247-262` omit that socket. Since the child’s private `/home` is replaced, the advertised path is absent. The prior real-child probe recorded `ESCALATION_SOCKET_EXISTS=false`. This fails closed, but the shipped feature is nonfunctional.

**Prerequisites / impact:** any normal Linux user invoking the documented escalation path. No host escape was shown. **Repair:** project only the intended escalation socket, with private ownership and lifecycle. **Acceptance test:** request escalation from the actual primary Bubblewrap child using the production approval callback; assert approved command output and assert denied/headless requests fail closed.

### Finding 11 / S7 — macOS escalation retains full backend channels: **CONFIRMED-STATIC, UNVERIFIED RUNTIME**

`macos-backend.ts:196-218` handles escalation by recursively creating a full macOS backend and launching `/bin/sh`. This retains the network proxy, credential and other RPC channels, while ADR 0024 requires a minimal second child without those channels; unlike Linux, it is not a dedicated runner. `:319` also inherits terminal stdio, and the implementation returns empty output rather than the documented captured result. No macOS execution was possible.

**Prerequisites / impact:** macOS plus an approved escalation (or concurrent hostile workspace inputs). This is excess authority and contract drift, not evidence of automatic approval bypass. **Repair:** separate minimal runner with filtered environment, no network/credential/handoff channels, captured output, and `finally` cleanup. Also pass the filtered environment on Linux escalation instead of allowing supervisor environment inheritance where applicable. **Acceptance test:** approved macOS command can only access its extra writable root and declared inputs; socket/channel probes are absent and stdout/stderr are returned.

### Finding 12 / S8 — directory projections mount parents: **CONFIRMED-STATIC; prior builder probe reproduced**

`packages/coding-agent/src/core/sandbox/bwrap-arguments.ts:52-54` binds `dirname(resolve(path))`; `macos-backend.ts:65-74` authorizes the parent similarly. `cli-launch.ts:305-306` supplies directory inputs, including skill roots. A requested `/home/example/.agents/skills` therefore projects `/home/example/.agents`, exposing sibling trees. The prior builder probe recorded `--ro-bind /home/example/.agents /home/example/.agents`; it did not read real home data.

**Prerequisites / impact:** a malicious child and sensitive sibling data under a projected parent; impact depends on host layout. **Repair:** distinguish executable-file projections from directory projections; bind the exact directory (or a private copied projection), and run ancestor checks against actual mounted authority. **Acceptance test:** inspect generated Linux and macOS policy for skill/package roots and prove sibling files are unreadable while requested descendants remain available.

### Policy projection (config-projection): **CONFIRMED; prior launch/store probe reproduced**

Normal startup repoints `APEX_CODE_CODING_AGENT_DIR` to workspace `.apex-code/sandbox-agent` (`packages/coding-agent/src/core/sandbox/cli-launch.ts:146-228,281-343`), and `main.ts:825-833` constructs the permission store there. `APEX_CODE_POLICY_PATH` is filtered rather than projected. Host user rules and custom managed-policy paths therefore do not reach the child; only the standard `/etc/apex-code/policy.json` fallback remains. The retained probe exited 0 and showed host rules present but `childRules: []`, `childPolicyOverride: null`, and no projected policy files.

**Prerequisites / impact:** user relies on host-level/custom policy and standard `/etc` policy is absent; a deny can disappear inside the sandbox. **Repair:** resolve policy in supervisor and pass an immutable, explicit snapshot; keep approvals outside child-writable workspace. **Acceptance test:** real sandbox launch with a host deny and custom policy path must show the same effective deny inside the child, while repository files cannot alter it.

## Credential helper and supervisor state trace

`git-credential-proxy.ts:97-109` validates reachability/release but accepts arbitrary protocol text; `git-credential-helper.ts:141-166` invokes `git credential fill` without production `cwd` and interpolates protocol/host into newline-delimited input. The prior synthetic helper probe confirmed workspace `credential.helper = !command` executes on the host and protocol newline injection changes the requested identity. `terminal-handoff.ts:82-88,150-151` uses ordinary path writes, so a workspace symlink can redirect supervisor writes; the prior scratch probe recorded `resume\n` outside the workspace. These are **CONFIRMED** conditional host-authority findings. Smallest repairs are a supervisor-owned non-repository cwd with config-discovery controls, strict CR/LF/NUL and scheme validation before authorization/serialization, and supervisor-private state with no-follow/descriptor-relative operations.

## Platform limits and gaps

- Linux user/PID/network namespaces, private `/dev` and `/proc`, and backend-unavailable fail-closed behavior were documented as working; I did not rerun them.
- Linux escalation omission is a fail-closed wiring defect, not a sandbox escape.
- macOS findings (profile race and escalation channel overreach) remain static because this host cannot execute Seatbelt.
- No fresh end-to-end public CLI probe was run. The report’s corrected CLI probe used a deliberately invalid provider and therefore proves launch/wiring, not a successful model turn.
- No real credential, provider, or live network service was used.

## Result

**ISSUES.** Findings 4, 9, 10, 11, 12, credential helper/protocol, supervisor symlink state, and policy projection remain actionable. Findings 9 and 11 are static/unverified on macOS; the other classifications are supported by current source plus retained safe probes. The highest-priority acceptance work is one parsed CLI representation, private supervisor state and policy snapshot, then real-child escalation/channel tests on Linux and macOS.
