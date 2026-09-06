# Platform boundaries remediation — design (read-only preparation)

**Status:** Design only. No source edits made.
**Owner handoff target:** `docs/plans/2026-09-05-plan-platform-boundaries.md` (PB.1–PB.5).
**Checkout:** `main` @ `cef3f5f1d5f2364596f525132f413500a5f93834` (`docs(security): record startup trust verification`).
Working tree clean except untracked `.apex-code/audit-*` and `.apex-code/security-remediation/*`.
The handoff's stated head (`7a03b6a1d…`) is stale. Every PB-relevant defect re-verified against
this HEAD; the PB files are unchanged since the audit checkout `1964612833…`.

## Evidence classification (read this first)

| Class | Meaning | Produced on |
|---|---|---|
| Static proof | Source trace + injected-`spawnChild` argv/profile capture. Proves the generated contract, not OS enforcement. | any host (Linux CI and macOS CI, plus local Linux) |
| Native evidence | A real `bwrap` (Linux) or `sandbox-exec` (macOS) child actually does the thing. | ubuntu-latest (bubblewrap) / macos-latest (sandbox-exec) only |

A Linux native run cannot close a macOS finding. macOS findings 2/3 remain static until
the macos-latest job runs. Do not mark PB.2/PB.3 verified from a Linux-only run.

---

## PB.1 — Project the Linux escalation socket (fail-closed wiring defect)

**Trace.**
- `command-proxy.ts` `resolveCommandEscalationChannelPaths()` returns `childSocketPath = "/home/apex-command-escalation.sock"` on Linux.
- `linux-backend.ts:225-236` starts `createCommandEscalationProxy` on the host socket.
- `linux-backend.ts:270` sets `APEX_COMMAND_ESCALATION_PATH` to `escalationPaths.childSocketPath`.
- `linux-backend.ts:247-262` builds the child's `sockets` array: network proxy, optional credential channel, git-credential channel — **the escalation socket is absent**.
- `/home` is `--tmpfs`-replaced (`bwrap-arguments.ts`), so the advertised path does not exist in the child.
- Effect: `requestCommandEscalation` (`rpc/command-client.ts`) gets ENOENT and returns `undefined`. The feature is dead but fails closed. No host escape shown.

**Minimal fix (static, one edit surface).**
Add `{ hostPath: escalationPaths.hostSocketPath, childPath: escalationPaths.childSocketPath }` to the primary-child `sockets` array in `linux-backend.ts`. Nothing else: the host proxy, approval (ADR 0023) and deny-fail-closed path (`rpc/command-proxy.ts`) already exist and are tested.

**File scope:** `packages/coding-agent/src/core/sandbox/linux-backend.ts` only.

**Failing tests (write first).**
1. *Static (any host):* injected-`spawnChild` capture asserts the primary `bwrap` argv contains `--bind <escalationHostSocket> /home/apex-command-escalation.sock`. Today absent → fails.
2. *Native Linux:* real child `sh -c 'test -S "$APEX_COMMAND_ESCALATION_PATH"'` exits 0. Today exits non-zero → fails.
3. *Native Linux (production path):* real child sends a framed `{op:"run",…}` over the socket; headless (no approver) → `{ok:false}`; injected approver `() => true` → command runs and stdout returns. The denied/headless halves are already unit-covered in `test/sandbox/command-escalation.test.ts`; the production-path reach is the new part.

**Static vs native:** 1 = static; 2/3 = native Linux only.

**Cleanup:** escalation dir `apex-escalate-<pid>-*` is already removed in `close()`. Add a regression test asserting no `apex-escalate-*` dir remains after `launch` + `close`.

**Performance:** no new imports, no new host resources. `node scripts/measure-supervisor-imports.mjs --dist` `cli-launch` row must be unchanged.

---

## PB.2 — macOS Seatbelt profile into private supervisor state (TOCTOU race)

**Trace.**
- `macos-backend.ts:160-161` `stateDirectory = join(workspace, ".apex-code", "sandbox-state")` — workspace-writable.
- `macos-backend.ts:285-286` writes `profile.sb` there with a plain `writeFileSync`.
- `macos-backend.ts:304` passes `-f profilePath` to `sandbox-exec`.
- Path is deterministic and reused per launch, so a concurrent workspace process (or a leftover from a prior child, since the workspace persists) can substitute/symlink the profile between write and read. Static race, not demonstrated on macOS.

**Minimal fix (mirrors existing channel dirs).**
Write the profile into a fresh, supervisor-private, per-launch `mkdtempSync(join(supervisorTempDirectory(), "apex-profile-"))` dir, `chmodSync(..., 0o700)`, unique path (never reused), then `rmSync(..., {recursive:true, force:true})` in `finally`. `supervisorTempDirectory()` is already the pattern for the escalation/git-credential/credential channels. The 0700 parent + mkdtemp uniqueness removes the deterministic path and the workspace-observable location; the child cannot write `/tmp` (`(deny file-write*)` except workspace/roots).

**File scope:** `packages/coding-agent/src/core/sandbox/macos-backend.ts` (add `mkdtempSync`/`chmodSync` imports and `supervisorTempDirectory` import; move the write; add cleanup). No other file.

**Failing tests.**
1. *Static (any host, injected spawn):* capture `sandbox-exec` argv; assert the `-f` path is **not** under `<workspace>/.apex-code` and starts with `/tmp/apex-profile-`; assert the dir exists with mode `0700` during launch and is gone after `close()` and after a spawn `error`. Today the path is under workspace state → fails.
2. *Native macOS — pre-existing symlink:* plant a symlink at the old deterministic path `<workspace>/.apex-code/sandbox-state/profile.sb` → harmless target; launch a real child; assert a write outside the workspace is still blocked (intended profile retained). Deterministic.
3. *Native macOS — replacement:* write a hostile profile at the old path before launch; assert intended enforcement still holds (the launched child never reads that path).
4. *Native macOS — concurrent substitution:* loop N launches while a background writer repeatedly overwrites/symlinks the old path; assert zero launches pick up the attacker profile. Probabilistic; keep as a native stress negative control, and state that structural uniqueness (test 1) is the deterministic proof.

**Static vs native:** 1 = static (deterministic proof of uniqueness); 2/3/4 = native macOS.

**Cleanup:** assert no `apex-profile-*` dir remains after success, failure, and `close()`.

**Performance:** adds one `mkdtemp`/`rmSync` per macOS launch and a tiny `supervisor-temp` import; negligible. `measure-supervisor-imports.mjs --dist` unchanged.

---

## PB.3 — Minimal macOS escalation runner (channel overreach + lost output)

**Trace.**
- `macos-backend.ts:206-218` `runEscalated` recursively calls `createMacosSandboxBackend(options)` and `launch(...)`. That full backend starts a network proxy, a git-credential proxy, terminal handoff, and **its own escalation proxy** (recursion), and inherits `launch.credentialChannel`.
- It returns `{ code, stdout: "", stderr: "" }` — captured output is discarded.
- `macos-backend.ts:319` stdio is `["inherit","inherit","pipe"]`, so escalated stdout draws over the TUI; only stderr is captured.
- ADR 0024 requires the second child to be deliberately smaller: no network relay, no credential channels, no terminal handoff, captured stdio.

**Minimal fix.**
Add a macOS `runEscalatedCommand` mirroring Linux's `linux-backend.ts:324-364`:
- build a minimal profile (no `network-outbound` proxy allow, no `unix-socket` allows) from a shared profile-builder helper so primary and escalated children cannot drift (same single-builder principle as `bwrap-arguments.ts`);
- spawn `sandbox-exec -f <private profile> -D … -- /bin/sh -c <command>` with writable roots `[…additional, request.writableRoot]`, read-only dirs/files from the launch, `cwd: workspace`, `env` filtered (child-safe keys only), stdio `["ignore","pipe","pipe"]`;
- capture stdout+stderr and return both;
- `finally` cleanup of the private profile dir.

To avoid drift, extract the primary launch's `profileLines` construction into one private `buildMacosProfile({ workspace, writableRoots, readOnlyDirs, readOnlyFiles, userHome, proxyPort?, sockets? })` used by both paths. Keep it in `macos-backend.ts` (smaller diff) unless it becomes >~120 lines, then promote to `core/sandbox/macos-profile.ts`.

**File scope:** `packages/coding-agent/src/core/sandbox/macos-backend.ts` (primary refactor + new runner). Optional adjacent hardening, Linux side, small and separable: `linux-backend.ts:347` spawns the escalated `bwrap` with no `env`, so the escalated child inherits the full supervisor environment; pass a filtered env (`{ PATH: process.env.PATH }`) to match the "minimal runner" invariant. Record this as a disposition; it is not required to close PB.3 (macOS).

**Failing tests.**
1. *Static (any host, injected spawn into the command proxy's `runEscalated`):* assert exactly one `sandbox-exec` spawn; assert its `-f` profile contains **no** `network-outbound` and no `unix-socket` line; assert stdio is `["ignore","pipe","pipe"]`; inject a child that emits stdout/stderr and assert the returned result carries them. Today it recursively builds a full backend and returns empty strings → fails.
2. *Native macOS:* approved command writes to the extra root, returns captured stdout; inside the escalated child `test -z "$APEX_COMMAND_ESCALATION_PATH"` and `test -z "$APEX_GIT_CREDENTIAL_PATH"` and `test -z "$APEX_CREDENTIAL_PROXY_PATH"` (no channel env); denied/headless request fails closed.
3. *Native macOS, non-recursion:* approved escalation does not create a second escalation/credential socket (assert via a host-side `/tmp` listing before/after).

**Static vs native:** 1 = static (channel-shape proof); 2/3 = native macOS.

**Cleanup:** minimal-runner profile dir removed in `finally`; no `apex-escalate-*`/`apex-gitcred-*`/`apex-cred-*` dirs created by the escalated path.

**Performance:** one extra `mkdtemp`+`rmSync` per approved escalation; no per-launch cost. No new heavy imports.

---

## PB.4 — Directory projections must not expose parent siblings

**Trace.**
- `bwrap-arguments.ts:52-54` `readOnlyMountArguments` always ro-binds `dirname(resolve(path))`. Correct for files, wrong for directories.
- `macos-backend.ts:65-74` `readOnlyDirectories` maps `dirname(resolve(path))` the same way.
- `cli-launch.ts:300-301` appends skill roots (directories) to `readOnlyPaths`.
- `cli.ts:105` passes `[getPackageDir(), dirname(getPackageDir())]` (directories) as `readOnlyPaths`.
- Linux: for a `/home`-resident skill root `/home/example/.agents/skills`, the parent `/home/example/.agents` is ro-bound, exposing sibling trees that `/tmpfs /home` would otherwise hide.
- macOS: for a `USER_HOME`-resident package/skill path, `RO_n = dirname(path)` re-allows the parent `subpath`, un-hiding siblings that `(deny file-read* (subpath USER_HOME))` should keep denied. (macOS global broad-read means the sibling issue only bites for `USER_HOME` paths; skill roots that resolve onto home are already refused by `resolveHostSkillPaths`, but the package-dir carve-out is a real case.)

**Minimal fix.**
Split the overloaded list into files vs directories:
- `supervisor.ts`: add `readOnlyDirectories?: readonly string[]` to `SandboxLaunch`.
- `cli-launch.ts`: place skill roots into `readOnlyDirectories`, not `readOnlyPaths`.
- `cli.ts` + `cli-supervisor.ts`: pass `getPackageDir()` / `dirname(getPackageDir())` as `readOnlyDirectories`.
- `bwrap-arguments.ts`: add `readOnlyDirectories` to `BwrapSpec`; add `readOnlyDirectoryMountArguments(dir)` = ancestor `--dir` entries + `--ro-bind <dir> <dir>`; keep `readOnlyMountArguments` for files.
- `linux-backend.ts`: primary child `readOnlyDirectories: launch.readOnlyDirectories ?? []`; escalated child (`:336`) also passes them so requested descendants stay available in both children.
- `macos-backend.ts`: `readOnlyDirectories` uses `resolve(path)` itself for directory entries, `dirname(resolve(path))` only for file entries.

**File scope:** `supervisor.ts`, `cli-launch.ts`, `cli-supervisor.ts`, `cli.ts`, `bwrap-arguments.ts`, `linux-backend.ts`, `macos-backend.ts` + tests.

**Failing tests.**
1. *Static (any host):* `buildBwrapArguments` with `readOnlyDirectories:["/home/x/.agents/skills"]` emits `--ro-bind /home/x/.agents/skills /home/x/.agents/skills` and does **not** emit `--ro-bind /home/x/.agents /home/x/.agents`. Today the parent bind is emitted → fails.
2. *Static (any host):* `cli-launch` test asserts skill roots land in `readOnlyDirectories`, and the package-dir paths from `cli.ts` do too.
3. *Static (any host):* macOS injected-spawn test asserts the `RO_n` param for a directory input equals the directory (canonical), not its parent.
4. *Native Linux:* skill root under the real `homedir()` with a sibling file next to its parent; child reads the marker inside the skill root and `test ! -e <sibling>`. Today the parent bind exposes the sibling → fails.
5. *Native macOS:* directory under `homedir()` (USER_HOME) with a marker inside and a sibling next to it; child `cat`-s the marker and gets EPERM on the sibling. Today `RO_n = dirname` re-allows the parent → fails.

**Static vs native:** 1/2/3 = static; 4 = native Linux; 5 = native macOS.

**Cleanup:** no new runtime state. Assert the host `/home`/`USER_HOME` tree is unchanged after a launch (bwrap `--dir`/`--ro-bind` of `/home`-resident dirs is namespace-local; verify, don't assume).

**Performance:** no new imports, no new syscalls in the hot path beyond what already exists. `measure-supervisor-imports.mjs --dist` unchanged.

---

## PB.5 — Record platform-specific guarantees (docs + diagnostics)

**Scope (land last, after PB.1–4 settle behavior).**
- `docs/adr/0005-sandbox-boundary-guarantees.md` (amend): state the repaired Linux escalation socket guarantee, macOS private-profile guarantee, minimal-runner channel bounds, and the remaining documented limits — macOS has no private per-process loopback (already recorded), macOS broad-read means sibling read-confidentiality is only enforceable for `USER_HOME` paths, Windows unsupported, Unix-socket reachability is a documented limit not a repaired guarantee.
- `README.md` / `docs/user-guide.md`: distinguish CLI (sandboxed child), SDK (explicit contract — PS.5), and RPC (headless deny) behavior per platform.
- Diagnostics strings in `core/sandbox/policy.ts` / `supervisor.ts` and backend `unavailable` reasons: keep Linux/macOS/Windows distinct; no new classifier (ADR 0010 — `buildToolContractSnapshot()` stays the only projection).

**File scope:** `docs/adr/0005-…`, `README.md`, `docs/user-guide.md`, `core/sandbox/policy.ts`, `core/sandbox/supervisor.ts` (diagnostic text only).

**Verification:** `node scripts/validate-docs-lifecycle.mjs .`; read-only doc claims match the PB.1–4 native evidence recorded in the plan task table.

---

## Exact commands

Focused, Linux (after the CI deps below are present):
```text
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
npm --prefix packages/coding-agent test --   test/sandbox/command-escalation.test.ts   test/sandbox/linux-backend.test.ts   test/sandbox/skill-mount-enforcement.test.ts   test/sandbox/cli-launch.test.ts
npx tsgo --noEmit
```

Focused, macOS (macos-latest; `sandbox-exec` already present):
```text
npm --prefix packages/coding-agent test --   test/sandbox/macos-backend.test.ts   test/sandbox/skill-mount-enforcement.test.ts   test/sandbox/command-escalation.test.ts
npx tsgo --noEmit
```

End-of-slice gates (both platforms, per AGENTS.md + handoff):
```text
npx tsgo --noEmit
npm test
npm run check
node scripts/validate-docs-lifecycle.mjs .
```

CI: the existing `.github/workflows/ci.yml` matrix already runs `npm run build`, `npm run check`, `npm test` on `ubuntu-latest`/`macos-latest`/`windows-latest`; ubuntu installs `bubblewrap` + the AppArmor `sysctl`, macOS runs `sandbox-exec`. A push/PR triggers it; `workflow_dispatch` re-runs it. No workflow change is needed for PB.

---

## Performance and cleanup checks (summary)

- Module cost: `node scripts/measure-supervisor-imports.mjs --dist` before/after — `cli-launch (whole supervisor path)` must not regress; PB adds no heavy imports.
- Launch latency: no baseline exists yet (handoff). Establish one with a scratch `launchSandboxedCli` probe (or `APEX_CODE_STARTUP_BENCHMARK`) and state a threshold before judging; PB.2/PB.3 add only per-launch `mkdtemp`/`rmSync` (macOS profile, escalated profile).
- Cleanup: assert no leaked `/tmp/apex-escalate-*`, `/tmp/apex-profile-*`, `/tmp/apex-gitcred-*`, `/tmp/apex-cred-*` dirs after success and after injected spawn failure; assert host `/home`/`USER_HOME` unchanged by PB.4.

## Order and ownership

PB.1 → PB.2 → PB.3 → PB.4 → PB.5. PB.1 is the smallest and independently native-verifiable. PB.2 then PB.3 are macOS-only and share `macos-backend.ts` (PB.3 depends on PB.2's private profile dir). PB.4 touches both backends plus the launch contract and should follow PB.3 so `macos-backend.ts` edits stay sequential. PB.5 last. Keep PB under one owner; do not parallelize with PS while the supervisor-state interface is changing (handoff).

## Recorded dispositions (do not silently widen scope)

- macOS sibling read-confidentiality is only enforceable for `USER_HOME` paths (broad `(allow file-read*)`); PB.4 fixes the `RO_n` carve-out, not global broad-read. Record in PB.5/ADR 0005.
- Linux escalated child currently inherits the supervisor's full environment (`linux-backend.ts:347`); filtered-env is a small separable hardening, disposition in PB.3.
- Unix-socket reachability remains a documented limit, not a repaired guarantee (handoff entry decision 8).
