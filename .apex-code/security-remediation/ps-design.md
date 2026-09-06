# PS design — Policy and supervisor authority

**Status:** Read-only architecture preparation. No source edits, no commits.
**Repo HEAD at read time:** `cef3f5f1d5f2364596f525132f413500a5f93834` (ST plan verified at `adf4a67f75c43d31689c72cf1be26dbbc218f9ef`; CA plan Not started; PS plan Not started).
**Never accessed:** `c-code`.

This document is the design note that precedes the PS implementation owner. It is
not a task table and not a progress board. The live plan remains
`docs/plans/2026-09-05-plan-policy-and-supervisor.md`.

---

## 1. What this note settles and what it does not

Settles, concretely:

- the four call-path traces the PS tasks depend on (verification/formatter,
  permission gate types, supervisor/terminal handoff, git credential, SDK),
- the smallest cohesive implementation for PS.1-PS.5 after CA lands, with exact
  file scopes, failing tests, and exact native commands,
- a feasibility verdict on formatter confinement that does not pretend
  post-hoc detection is confinement,
- the compatibility traps and where an ADR is required.

Does not settle:

- the canonical operation model itself (CA owns it),
- the macOS profile placement / minimal escalation runner (PB owns them),
- release artifact identity (RI owns it).

---

## 2. Trace results

### 2.1 Verification and formatter call paths (PS.1, PS.2)

Authorized-tool path (the gate these commands bypass):

- `AgentSession` wires one gate in `core/agent-session.ts` around line 713:
  `evaluateToolCall(toolName, args, { ...this._permissionGate, getContract,
  getResponder })`. The gate is `core/permissions/gate.ts`.
- `evaluateToolCall` calls `store.snapshot()` (fail closed on errors), then
  `resolvePermission(snapshot.rules, toolName, spec, params)` from
  `core/permissions/rules.ts`, then `resolveWithMode(mode, resolution,
  contract.capabilities)` from `core/permissions/modes.ts`, then handles
  `allow` / `deny` / `ask` (ask fails closed without a responder).
- `resolveWithMode` is the capability overlay: plan mode denies
  `{fs.write, exec, delegate}`; a `policy`-source rule is preserved; bypass
  allows only lower sources; otherwise the rule or tool default applies.

Configured-command path (no gate):

- `core/policy-loader.ts` parses and validates `permission: "allow" | "ask" |
  "deny"` (default `ask`) into `CommandPolicy`. The executor never reads it.
- `VerificationTracker.runExplicit` (`core/verification-lifecycle.ts`, ~line
  122) calls `runPolicyCommand(policy, {...})` directly.
- `runFormatterCommand` (`core/formatter-lifecycle.ts`, ~line 230) snapshots
  the workspace, calls `runPolicyCommand` directly, then diffs before/after.
  `runPolicyCommand` (`core/policy-executor.ts`, spawn ~line 154) spawns
  `executable argv` with `shell:false` and **no permission decision**.
- Public entry points: `AgentSession.requestVerification()` (~line 2372) and
  `AgentSession.runConfiguredFormatter()` (~line 2392). Post-turn verification
  runs in `_runVerificationTurnBoundary()` (~line 2436).
- Formatter status is `run.status` (`passed`/`failed`/...) even when
  `undeclaredPaths` or `escapedPaths` are non-empty. The module header is
  explicit: "Nothing is reverted — the workspace belongs to the user; the
  report is the evidence." That is the observation-only defect.

Gate types (what PS.1 must reuse, not reinvent):

- `PermissionGateOptions` (`core/permissions/gate.ts`): `getContract`, `store`,
  `getMode`, `flagMode?`, `responder?`, `getResponder?`.
- `GateDecision` = `{ block: boolean; reason?: string }`.
- `PermissionMode` / `PermissionRuleStore` in `core/permissions/store.ts`;
  `resolveWithMode` and `PermissionResolution` are exported and reusable.
- There is **no tool name or rule grammar for a configured command**. Managed
  `policy`-source rules name tools (`bash`, `write`, ...); they cannot express
  "deny verification policy X" today. PS.1 must therefore use the capability
  overlay (`resolveWithMode`) plus the policy's own `permission` ceiling, not
  `evaluateToolCall`, which requires a tool+params and rule matching.

### 2.2 Supervisor state ownership and terminal handoff (PS.3)

- `linux-backend.ts` ~line 138: `stateDirectory =
  join(launch.policy.workspace, ".apex-code", "sandbox-state")`; `mkdirSync`
  there, then `createTerminalHandoff(stateDirectory)`,
  `writeGitCredentialHelper(stateDirectory)`, `relay.cjs` in `stateDirectory`,
  `terminal-size` in `stateDirectory`; child `HOME`/`TMPDIR` are
  `stateDirectory`. This directory is **child-writable** (workspace is
  bind-mounted read-write).
- `macos-backend.ts` ~line 160 does the same; its `profile.sb` also lives there
  (PB.2's concern, not PS.3's).
- `terminal-handoff.ts`: supervisor `writeFileSync(statePath, "suspend\n")`
  and `rmSync(ack)` follow symlinks; `stop()` writes `resume`. A child-placed
  symlink at `sandbox-state/terminal-handoff` redirects the supervisor's host
  write outside the workspace (proven by the audit probe).
- `terminal-size.ts`: supervisor `writeFileSync(path, ...)` on resize — same
  symlink-following shape.
- `cli-launch.ts` `buildChildEnvironment` allowlist **filters out
  `APEX_CODE_POLICY_PATH`**, and `APEX_CODE_CODING_AGENT_DIR` is repointed to
  workspace `.apex-code/sandbox-agent`. Result: a host custom managed policy
  and host user-scope rules do not reach the child (the config-projection
  defect). The store falls back to `/etc/apex-code/policy.json` only.

### 2.3 Git credential proxy/helper (PS.4)

- `git-credential-proxy.ts` `answer()`: reads `request.host` and
  `request.protocol`, checks only `!host`, then `isHostAllowed(host)` ->
  `release(host)` -> `fillCredential({host, protocol})`. **No protocol or host
  field validation.**
- `git-credential-helper.ts` `fillHostGitCredential`: spawns
  `git credential fill` with `cwd: options?.cwd` (**undefined in production**)
  and `env: process.env`; serializes
  `protocol=${request.protocol}\nhost=${request.host}\n\n`. Git therefore
  discovers the workspace repository config, so `credential.helper = !command`
  executes on the host, and a `protocol` containing `\nhost=...\n\n` changes
  the requested identity after the release check.
- `cli-supervisor.ts` derives `credentialHelper` from
  `join(workspace, ".apex-code", "sandbox-state")`; the backends write the
  helper `.cjs` into that same workspace directory (`writeGitCredentialHelper`).

### 2.4 SDK embedding contract (PS.5)

- `core/sdk.ts` `createAgentSession` exposes `CreateAgentSessionOptions` with
  **no sandbox field**. `createMcpRuntime` receives `projectTrusted` (ST.2),
  and eager MCP warm still runs unconditionally. The OS boundary is a property
  of the CLI supervisor (`cli.ts` / `cli-supervisor.ts`), not of the SDK.
- `cli.ts` sets `APEX_CODE_CODING_AGENT=true` in **both** the sandboxed child
  (`child-entry.ts`) and the host fallback, so that value is not a sandbox
  marker. `child-entry.ts` additionally receives the terminal-size and handoff
  env vars, but nothing that asserts "I am inside the enforced boundary."

---

## 3. Smallest cohesive implementation after CA

Dependency note: PS.1 reuses the canonical command value from CA.1, but per the
handoff entry decision it does **not** require a universal operation object. A
small typed boundary value is enough; if CA has not named one, PS.1 defines
`ConfiguredCommandOperation` locally and CA's ADR absorbs it.

### 3.1 PS.1 — route verification/formatting through command authorization

New seam (one new file):

- `packages/coding-agent/src/core/permissions/policy-command.ts`
  - `type ConfiguredCommandCapabilities = "exec" | "exec+write"` (or a
    `ReadonlySet<Capability>`).
  - `interface ConfiguredCommandOperation { executable: string; argv: string[];
    cwd: string; writeScope: readonly string[] | undefined; capabilities:
    ReadonlySet<Capability>; permission: PolicyPermission; }`
  - `async function authorizeConfiguredCommand(op, options): Promise<GateDecision>`
    where `options` = `{ getMode, responder?, getResponder? }`. Semantics:
    1. `op.permission === "deny"` -> `{ block: true }` **before any mode**.
    2. `base = op.permission === "allow" ? "allow" : "ask"`.
    3. `resolution = resolveWithMode(await getMode(), { behavior: base },
       op.capabilities)` — plan mode's `exec`/`fs.write` floor applies; bypass
       only lowers `ask`.
    4. `allow` -> pass; `deny` -> block; `ask` -> require responder, fail
       closed without one, decline blocks. No `persist` (a configured command
       has no tool name to persist a rule against).

Change these callers:

- `core/verification-lifecycle.ts`: add `authorize?: (op) => Promise<GateDecision>`
  to `VerificationTrackerOptions`; `runExplicit` builds the operation
  (`capabilities: {exec}`, `writeScope: undefined`, `permission: policy.permission`)
  and returns an `interrupted`/new refusal record without spawning when blocked.
- `core/formatter-lifecycle.ts`: add `authorize?` to `FormatterRunOptions`;
  `runFormatterCommand` authorizes with `capabilities: {exec, fs.write}` and
  `writeScope = intersectPatterns(declared, pathScope)`, and short-circuits to
  `status:"refused"` on a block before any snapshot or spawn.
- `core/agent-session.ts`: build the `authorize` closure from
  `this._permissionGate.getMode` and the same responder chain used at line
  ~721 (`_permissionResponderFactory` then `createInteractiveResponder`), and
  pass it into the tracker and `runFormatterCommand`.

`runPolicyCommand` stays a pure spawner (no gate param) so its existing tests
and `refused` semantics remain intact.

Failing tests first:

- New `packages/coding-agent/test/policy-authorization.test.ts`:
  - `permission:"deny"` verification -> marker never created, status is not
    `verified`, and the gate/authorize was consulted.
  - `permission:"ask"` with no responder -> fail closed.
  - plan-mode gate + `permission:"allow"` verification/formatter -> blocked by
    the `exec`/`fs.write` floor.
  - approved `allow` in default mode still runs (positive control).

Exact native command:

```text
npm --prefix packages/coding-agent test -- test/policy-authorization.test.ts
```

### 3.2 PS.2 — formatter scope by isolated copy + restricted promotion

Mechanism (portable, no new privileged primitive):

1. `runFormatterCommand` resolves `tracked` declared patterns as today.
2. Materialize the workspace into a private stage directory under the
   supervisor/system temp dir (`mkdtempSync`), using `fs.copyFile` with
   `COPYFILE_FICLONE` where the platform supports reflink and a plain copy
   fallback. Skip `.git`, `node_modules`, `.apex-code`, `sessions` (they are
   never declared and never promoted). Keep the existing snapshot caps.
3. Run `runPolicyCommand` with `cwd` set to the stage root, not the live
   workspace.
4. Diff stage against the pre-run materialization. For every change:
   - inside `tracked` -> eligible for promotion;
   - outside `tracked` -> mark `scope-violated`, never promote.
5. Promote only eligible declared changes back to the live workspace with a
   no-follow write, guarded by a pre-overwrite content check: if the live file
   differs from the pre-run fingerprint, the user changed it concurrently,
   refuse that file's promotion and mark the run failed.
6. `outcome.status` is never `"passed"` when `scope-violated` or promotion is
   incomplete. Add `"scope-violated"` to `PolicyRunStatus` (additive); map it
   in `verification-lifecycle.recordOutcome` to a failed/interrupted outcome so
   it can never surface as `verified`.

Feasibility verdict (honest):

- OS-enforced per-path write confinement of a formatter requires a nested OS
  sandbox (bwrap / sandbox-exec) started by the supervisor with only declared
  paths writable. That cannot be erected from inside the already-sandboxed
  child (nested unprivileged user namespaces are not projected and bwrap is not
  in the child), and it is a platform-backend/supervisor concern (PB), not PS.
- Therefore PS.2 implements **copy + restricted promotion**, which confines
  *workspace mutation to the declared set*. It does **not** confine host-wide
  absolute-path writes or network access in an unsandboxed SDK embedding. Those
  are the OS boundary's job (CLI) or the embedder's (PS.5). PS.2 must not claim
  OS confinement.
- Anti-patterns rejected: treating post-hoc detection as confinement; using a
  git worktree as a sandbox; reverting live workspace files after the fact.

Failing tests first (rewrite `test/formatter-lifecycle.test.ts`):

- undeclared write (`stray.txt`) -> status `scope-violated`, `stray.txt`
  bytes unchanged in the live workspace, declared `src/a.ts` promoted.
- symlink escape -> outside target unchanged, status not `passed`.
- concurrent edit guard -> a file modified during the run is not overwritten.
- positive control: declared-only change still `passed` and promoted.

Exact native command:

```text
npm --prefix packages/coding-agent test -- test/formatter-lifecycle.test.ts
```

### 3.3 PS.3 — supervisor state + policy snapshot outside child-writable roots

State relocation (no-follow + outside workspace):

- `core/sandbox/terminal-handoff.ts`: split the directory into a
  supervisor-private **command** path and a child-writable **acknowledgement**
  path. The supervisor writes `suspend`/`resume` to a `0700` dir under
  `supervisorTempDirectory()` (host path, child sees it read-only through the
  bwrap read-only `/` bind; macOS Seatbelt denies writes there). The child
  writes the ack to a child-writable path: `/home/...` on Linux, workspace
  `.apex-code/sandbox-state` on macOS. Ack content is not authority (ADR 0023),
  so child-writability is safe.
- `core/sandbox/terminal-size.ts`: move the size file into the same private
  supervisor dir (child read-only).
- `core/sandbox/rpc/git-credential-helper.ts`: write the helper `.cjs` into the
  supervisor-private dir (0700), not the workspace; keep `gitCredentialHelperCommand`
  deriving the same path.
- `linux-backend.ts` / `cli-supervisor.ts`: stop deriving helper/relay/handoff
  paths from `workspace/.apex-code/sandbox-state`; allocate one private
  supervisor dir and pass it through the launch contract. `relay.cjs` moves to
  the same private dir (it runs on the host command line).
- Use descriptor-relative no-follow writes (`open(O_CREAT|O_EXCL|O_NOFOLLOW)`,
  then write via the fd) for any remaining workspace-adjacent supervisor write;
  do not "check then write" by path.

Policy snapshot (closes config-projection):

- `cli-launch.ts` / `cli-supervisor.ts`: in the supervisor, read the resolved
  managed policy (`APEX_CODE_POLICY_PATH` from the outer env, else
  `/etc/apex-code/policy.json`) and the host user `permissions.json` from
  `getAgentDir()` **before** repointing. Serialize them into one snapshot file
  under the private supervisor dir and pass its path via a new env var
  (`APEX_CODE_POLICY_SNAPSHOT_PATH`), projected read-only.
- `core/permissions/store.ts`: accept a `policySnapshotPath` option; when
  present, read the snapshot for the `policy` and host-`user` sources instead
  of the default path / repointed agentDir. Keep ST.3's once-captured
  project/local behavior unchanged. The snapshot file is outside the workspace
  and read-only, so the child cannot rewrite it.
- macOS profile (`profile.sb`) stays with PB.2; do not duplicate it here.

Failing tests first:

- Extend `test/sandbox/terminal-handoff.test.ts` + new
  `test/sandbox/supervisor-state.test.ts`:
  - a pre-placed symlink at the old state path cannot redirect a supervisor
    write (outside file unchanged; write lands in the private dir);
  - a custom `APEX_CODE_POLICY_PATH` host policy and a host user rule reach the
    child store and equal the supervisor snapshot;
  - child mutation of the snapshot path is refused (read-only projection).

Exact native commands:

```text
npm --prefix packages/coding-agent test -- test/sandbox/terminal-handoff.test.ts test/sandbox/supervisor-state.test.ts
npm --prefix packages/coding-agent test -- test/sandbox/cli-launch.test.ts test/sandbox/cli-process.test.ts
```

### 3.4 PS.4 — harden git credential execution and protocol validation

- `core/sandbox/rpc/git-credential-proxy.ts`: add
  `parseGitCredentialRequest(request): { protocol: string; host: string } | refusal`.
  Reject `\r`, `\n`, `\u0000`, and any other control/whitespace char in
  `host` and `protocol`; require a non-empty host; normalize protocol scheme to
  lowercase and require the shape `[A-Za-z][A-Za-z0-9+.-]*` (do **not** hardcode
  an `https`-only allowlist — that breaks `ssh`/custom helper flows). Authorize
  and serialize only the parsed structured identity, so the released host cannot
  differ from the serialized host.
- `core/sandbox/rpc/git-credential-helper.ts` `fillHostGitCredential`:
  - run `git credential fill` with `cwd` set to a fresh private empty directory
    (0700) created by the supervisor, never `undefined`;
  - construct the environment as `process.env` minus `GIT_DIR`, `GIT_WORK_TREE`,
    `GIT_INDEX_FILE`, `GIT_CONFIG` (repository discovery / config injection
    controls), while **preserving** `HOME` and global/system config so the host
    helper (gh / libsecret / keychain / `credential.helper` in `--global`)
    still resolves;
  - optionally set `GIT_CEILING_DIRECTORIES` to the private dir as a second
    guard.
- Keep `isHostAllowed`/`release` ordering unchanged; they now see the validated
  structured identity.

Failing tests first (extend `test/sandbox/git-credential-channel.test.ts`):

- `protocol` = `https\nhost=other.invalid\n\n` -> refused before
  `fillCredential` runs and before any `isHostAllowed` call for the injected
  host;
- CR / NUL / scheme-with-control-char injection refused;
- a scratch repo with `credential.helper = !<marker command>` produces no
  marker when `fillHostGitCredential` runs against it (workspace config never
  executes on the host).

Exact native command:

```text
npm --prefix packages/coding-agent test -- test/sandbox/git-credential-channel.test.ts
```

### 3.5 PS.5 — SDK sandbox contract

- `core/sdk.ts`: add `sandbox?: "required" | "external" | "none"` to
  `CreateAgentSessionOptions` (typed union, default `"none"`).
  - `"none"`: no OS containment; emit a startup diagnostic saying so.
  - `"external"`: caller asserts external containment; documented, not
    verifiable by the SDK; same diagnostic.
  - `"required"`: SDK refuses to construct the session unless a supervisor
    marker is present (`APEX_CODE_SANDBOX_ENFORCED=1`, set only by the bwrap /
    sandbox-exec command line, never from the invoking shell or project env —
    ADR 0016).
- `cli.ts` / `core/sandbox/child-entry.ts` / `cli-launch.ts`: set
  `APEX_CODE_SANDBOX_ENFORCED=1` inside the enforced child only (the marker
  rides the launch `environment`, not `buildChildEnvironment`), and pass
  `sandbox:"required"` on the child session. `danger-full-access` passes
  `"external"`. Delegated children inherit the parent's contract value.
- `packages/coding-agent/src/index.ts` / `core/sdk.ts` docstring + a short
  `docs/architecture/sdk-sandbox-contract.md` section (or README note) stating
  the three states and that the SDK never implies OS containment.

Failing tests first (new `test/sdk-sandbox-contract.test.ts`):

- `sandbox:"required"` with no marker refuses session construction;
- `"external"` and `"none"` construct but surface the no-containment diagnostic;
- delegated child inherits the parent contract.

Exact native command:

```text
npm --prefix packages/coding-agent test -- test/sdk-sandbox-contract.test.ts
```

---

## 4. Compatibility traps

1. **SDK `sandbox` option is a breaking surface.** Making it required breaks
   every `createAgentSession` caller and test. Use an optional typed union with
   default `"none"` plus diagnostics; do not silently accept a project-supplied
   marker (the marker must come only from the supervisor's own launch, ADR
   0016).
2. **Terminal handoff env-var semantics change.** `TERMINAL_HANDOFF_PATH_VARIABLE`
   currently names a shared directory; the split (command path vs ack path)
   changes both sides and any test reading the env var. macOS has no `/home`
   tmpfs, so the ack must stay under the workspace there — keep the two
   platforms' ack location explicit, not assumed identical.
3. **Credential fill environment must keep host helpers working.** Clearing
   `HOME` or global config would break gh/libsecret/keychain. Remove only
   repository-discovery / injection vars (`GIT_DIR`, `GIT_WORK_TREE`,
   `GIT_INDEX_FILE`, `GIT_CONFIG`) and run from a private empty cwd; preserve
   global/system config.
4. **Do not hardcode a two-scheme git protocol allowlist.** Validate structure
   (no CR/LF/NUL/control/whitespace, valid scheme shape) rather than
   allowlisting `https`/`http` only; `ssh` and custom helper schemes must keep
   working or be explicitly refused in a recorded decision.
5. **New `PolicyRunStatus` value is additive but must be mapped.** Anything
   downstream that switches on status (`verification-lifecycle.recordOutcome`,
   `agent-session` completion) must map `scope-violated` to failed/interrupted,
   never `verified`.
6. **`runPolicyCommand` must stay a pure spawner.** Adding a required gate
   parameter breaks its existing tests and any extension callers. Put
   authorization in a new wrapper (`authorizeConfiguredCommand`) and keep the
   executor unchanged.
7. **Formatter copy stage cost.** Full-workspace materialization is expensive
   for large repos. Reuse the existing snapshot caps, skip the four never-
   declared directories, prefer reflink (`COPYFILE_FICLONE`) with copy
   fallback, and record the cost as a measured bound — do not claim confinement
   is free.
8. **Concurrent edits during a formatter run.** Promotion must not overwrite a
   file the user changed concurrently; guard with a pre-overwrite fingerprint
   check and refuse the file (mark the run failed) rather than reverting user
   work.

---

## 5. Where an ADR is required

1. **SDK sandbox contract** (`required` / `external` / `none`) — new ADR. The
   umbrella spec already says "Create a separate ADR when implementation
   settles ... the SDK sandbox contract." Cite the spec and replace the open
   choice with the settled values + marker rule.
2. **Formatter confinement mechanism** — amend ADR 0028 (or a short new ADR).
   ADR 0028 currently says a formatter is "exec plus fs.write confined to its
   declared paths" without saying how; PS.2 settles copy + restricted
   promotion as the portable mechanism and explicitly records that per-path OS
   confinement is a supervisor/PB concern, not claimed by PS.
3. The **canonical operation model** ADR is CA's, not PS's; PS.1's
   `ConfiguredCommandOperation` boundary value is absorbed into that ADR and
   must not spawn a second one.

---

## 6. Verification gates (exact commands)

Per `AGENTS.md` and the implementation handoff:

```text
npx tsgo --noEmit
npm --prefix packages/coding-agent test -- <narrow test file(s)>
npm test
npm run check
node scripts/validate-docs-lifecycle.mjs .
```

Run the narrow file first, `npx tsgo --noEmit` regularly while editing, and
`npm test` at the end of each completed slice. Record the real commit SHA per
task only after its focused check passes. Do not relabel an isolated rerun as a
green full suite; the audit baseline already had two flaky
`startup-session-name` failures.
