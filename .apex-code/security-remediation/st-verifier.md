# ST verifier report: startup/trust commits

**Verdict: PASS** (after ST.3 repair `aa3bbb2c4`)

**Commits reviewed:**
- `adf4a67f75c43d31689c72cf1be26dbbc218f9ef` — implementation
- `cef3f5f1d5f2364596f525132f413500a5f93834` — plan close (v1)
- `aa3bbb2c4eab49eba465699205ce054139affcd3` — ST.3 user-scope repair

All three resolve via `git cat-file -t` = `commit`. HEAD at final verification is
`aa3bbb2c4eab49eba465699205ce054139affcd3`.

## First-pass finding (now resolved)

The v1 fix froze only `local`/`project` scopes. The `user` scope remained re-read
live on every snapshot, and in a sandboxed session its file lives in the workspace
(`<workspace>/.apex-code/sandbox-agent/permissions.json`). A write-capable session
could therefore write the user-scope file and widen its own authorization. Runtime
probe reproduced `user: bypassPermissions` appearing on the next snapshot.

## Repair review (`aa3bbb2c4`) — correct

`packages/coding-agent/src/core/permissions/store.ts`:

- `user` scope is now captured once, like `local`/`project`
  (`capturedFileBackedScope`, `store.ts:185-191`; snapshot reads all three through
  it, `store.ts:222-227`). `readFileBackedScope` has no caller outside the capture
  (grep confirms line 188 only). Direct and symlink replacement of project, local,
  and user files can no longer widen the current or next snapshot.
- Untrusted `local`/`project` are pre-seeded empty in the constructor
  (`store.ts:40-43`) and never read; `user` is still captured normally, which is
  correct — the user scope is host/user-owned, not project-controlled.
- `apply()` now operates on the captured scope, applies the update immutably
  (`applyToScope` returns new objects), persists the result through the backend
  lock, and only then updates the in-memory capture (`store.ts:257-271`). Per-
  destination updates are serialized via `fileScopeUpdates`; a failed write leaves
  the capture unchanged (fail-closed). The in-app paths that persist
  (`AgentSession.setPermissionMode` -> `destination: "user"`,
  `core/agent-session.ts:2050`; gate persist -> `destination: "session"`) work
  through this and remain immediately visible.
- Managed policy stays live: `readPolicy()` is still read fresh on every snapshot
  (`store.ts:208-219`, `:223`). Policy is host-owned and not child-writable in the
  sandbox (`APEX_CODE_POLICY_PATH` is absent from `SAFE_CHILD_ENVIRONMENT_KEYS` in
  `cli-launch.ts`; `/etc` is under the read-only root bind in
  `bwrap-arguments.ts`).

Tests (`test/startup-trust.test.ts`, now 8 tests) add exactly the missing cases:
user direct replacement, user symlink replacement, `apply()` refreshing only its
own destination while leaving project frozen, and managed policy staying live.

## Verification (rerun at HEAD aa3bbb2c4)

- `npm --prefix packages/coding-agent test -- test/startup-trust.test.ts test/sandbox/cli-launch.test.ts`
  -> 2 files, 31 tests passed.
- `npm --prefix packages/coding-agent test -- test/sandbox/cli-process.test.ts`
  -> 1 file, 7 tests passed (public CLI boundary).

## Non-blocking observations

1. `apply()` writes the captured-scope result over the on-disk file without
   re-reading/merging concurrent on-disk content (`store.ts:263-267`). On the
   sandbox path the user scope is ephemeral and only this store writes it, so no
   loss. On the host SDK path, a human hand-editing
   `~/.apex-code/agent/permissions.json` mid-session could have that edit
   clobbered by a later `apply()`. Rare; acceptable given the security goal, but
   worth a comment or test if host-path persistence semantics matter.
2. The plan-table close edit (`docs/plans/2026-09-05-plan-startup-and-trust.md`:
   ST.3 row now cites `aa3bbb2c4`, and the Order-changes note records the verifier
   reopening) was present in the working tree at review time but not yet committed.
   It should land before the plan is considered closed.
