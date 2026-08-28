**Status:** Active

# Sandbox delegation and escalation implementation plan

**Goal:** Close the delegation half of the OS sandbox. A session should be able to author
a commit as the user, reach a host it asks for, push with a host-owned credential, and
continue past a refusal — without the host home ever becoming visible and without project
settings ever widening their own boundary.

**Spec:** `docs/specs/2026-08-28-sandbox-delegation-and-escalation.md`

**Architecture:** Every unit puts the new authority in the supervisor, which already runs
unsandboxed, and gives the child only a narrow handle to it. Units 1 and 4 follow ADR
0015's projection-and-channel pattern. Units 3 and 6 extend the framed RPC protocol in
`core/sandbox/rpc/` that ADR 0005 named as escalation's missing prerequisite. Unit 5
changes the policy type; units 2 and 7 carry no runtime risk.

**Tech stack:** TypeScript, Vitest, `bwrap` on Linux and `sandbox-exec` on macOS, the
existing framed Unix-socket protocol.

## Task table

| Task | Unit | Status | Commit |
| --- | --- | --- | --- |
| SDE.1 | U1 | Done | `37e6708d6` |
| SDE.2 | U1 | Done | `37e6708d6` |
| SDE.3 | U2 | Done | `0867d9e2c` |
| SDE.4 | U3 | Done | pending |
| SDE.5 | U3 | Done | pending |
| SDE.6 | U4 | Done | `ee4c7dd95` |
| SDE.7 | U4 | Done | `ee4c7dd95` |
| SDE.8 | U5 | Done | `7c4fdebc4` |
| SDE.9 | U5 | Done | `7c4fdebc4` |
| SDE.10 | U6 | Done | `8c53a8001` |
| SDE.11 | U6 | Done | `8c53a8001` |
| SDE.12 | U7 | Done | `8f2c28620` |
| SDE.13 | — | In progress | — |

**Verification run, stated as run.** Root `npm test` on 2026-08-28: 339 test files passed,
6 skipped; 2868 tests passed, 58 skipped, 0 failed, in 1189s. A calm run — none of the
load-flake signature Phase 2b's roadmap entry records for this machine. `npm run check`
passed end to end, including `check:docs`, `check:shrinkwrap`, `check:install-lock`, and
`tsgo --noEmit`.

Order is load-bearing. SDE.8 and SDE.9 ship the escape hatch and must not land before
SDE.4 through SDE.7, or the delegation work loses its forcing function — the risk the
spec names in Risks and Rollout.

### SDE.1: Prove the git identity projection boundary

**Files:**

- Modify: `packages/coding-agent/test/sandbox/cli-launch.test.ts`
- Create: `packages/coding-agent/test/sandbox/git-identity.test.ts`
- Read: `packages/coding-agent/src/core/sandbox/cli-launch.ts`
- Read: `packages/coding-agent/src/core/sandbox/linux-backend.ts`

1. Add failing tests for host identity resolution: both keys present, neither present,
   one present, and a host config carrying `credential.helper` and `url.insteadOf` that
   must not survive into the projected file.
2. Add a failing test that repository-scope identity is not consulted, so a workspace
   `.git/config` cannot influence what the supervisor projects.
3. Add failing `buildSandboxedCliLaunch` tests that a projected config path appears in
   `readOnlyFiles` alongside `authPath`, that `GIT_CONFIG_GLOBAL` names it, and that both
   are absent when the host has no identity.
4. Add the regression test the spec's first Risk names: two projected files in separate
   directories are both readable in the child, because `readOnlyMountArguments` emits
   `--tmpfs <parent>` per file and two files sharing a parent would hide one.
5. Run `npm --workspace packages/coding-agent test -- sandbox/git-identity.test.ts sandbox/cli-launch.test.ts`.
6. Confirm each fails for the right reason: the module does not exist, and
   `buildSandboxedCliLaunch` takes no such option.

**Outcome.** Both failed as predicted. The same-directory case was then probed directly
against a real `bwrap` child before writing any fix, and the collision the spec listed as
a risk is real: projecting two files from one directory left the child with `ENOENT` for
the first and the second intact. That promoted the mitigation from "always use a separate
directory" to the code change in SDE.2 step 1, because a convention nothing enforces would
have been re-broken by SDE.7's third projection.

### SDE.2: Synthesize and project the git identity

**Files:**

- Create: `packages/coding-agent/src/core/sandbox/git-identity.ts`
- Modify: `packages/coding-agent/src/core/sandbox/linux-backend.ts`
- Modify: `packages/coding-agent/src/core/sandbox/cli-launch.ts`
- Modify: `packages/coding-agent/src/core/sandbox/cli-supervisor.ts`
- Modify: `packages/coding-agent/src/cli.ts`
- Test: `packages/coding-agent/test/sandbox/git-identity.test.ts`, `sandbox/cli-launch.test.ts`

1. Group read-only file projections by parent directory in `linux-backend.ts`, so one
   `--tmpfs` per directory carries every file bound into it. Added ahead of the identity
   work because SDE.1 proved the per-file `--tmpfs` silently hides all but the last file
   in a directory, and U1 is the change that introduces a second projection. macOS needs
   no equivalent: it projects each file as its own Seatbelt `subpath` param, with no
   tmpfs involved.
2. Resolve host `user.name` and `user.email` with a single `git config --global
   --get-regexp` call. The scope flag is what excludes the workspace's `.git/config` by
   construction rather than by picking a lucky working directory. System scope is not
   consulted, because a machine-wide commit identity is not a real configuration and a
   second spawn would cost every launch what it saves nobody.
3. Write a two-key config into a supervisor-owned `0700` directory of its own, mirroring
   `resolveCredentialChannelPaths`. Synthesize the file; never copy the host's.
4. Thread the path through `launchSandboxedCli` into `buildSandboxedCliLaunch`, appending
   to `readOnlyFiles` and setting `GIT_CONFIG_GLOBAL` after `childEnvironment` so the
   supervisor's value wins.
5. Remove the directory in the supervisor's `finally`, beside the credential proxy's
   cleanup.
6. Project nothing and set nothing when the host has no identity or has no `git`.
7. Run the focused test files until green, then `npx tsgo --noEmit`.
8. Commit, and record the verified SHA in the task table for SDE.1 and SDE.2.

### SDE.3: Reconcile the contradictory documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/user-guide.md`
- Modify: `AGENTS.md`

1. Make `README.md:472` agree with `README.md:352` about `/share` credentials.
2. Correct `docs/roadmap.md:257` to state that interactive escalation is deferred per ADR
   0005, rather than listing it as delivered 2b scope.
3. State plainly that `bypassPermissions` is a tool gate and cannot affect the OS
   boundary, which is fixed before the child starts.
4. Document U1's behaviour: commits carry host identity, and no credential is projected.
5. Link this plan from `docs/roadmap.md` as a real markdown link. `check:docs` requires
   `[text](plans/<name>.md)` and does not accept a backticked path, so a live plan that
   is only mentioned still fails the gate.
6. Fix `AGENTS.md`'s validation gate. It instructs agents to run `npm run typecheck`,
   which is not a script in `package.json`. The real gates are `npx tsgo --noEmit` for
   types alone and `npm run check` for the full lint, docs, and type pass. Found while
   running SDE.2's own gate.

### SDE.4: Prove interactive network escalation

**Files:**

- Modify: `packages/coding-agent/test/sandbox/network-proxy.test.ts`
- Modify: `packages/coding-agent/test/sandbox/network-allowlist.test.ts`
- Read: `packages/coding-agent/src/core/sandbox/rpc/credential-proxy.ts`

1. Failing test: a refused host raises exactly one request naming that host.
2. Failing test: approval permits that host and still denies a second, different host.
3. Failing test: concurrent requests for the same refused host raise one prompt, not one
   per connection.
4. Failing test: with no approver configured the proxy denies exactly as it does today,
   so headless and non-interactive modes keep ADR 0005's behaviour by construction.
5. Failing test: a denial leaves the host refused on the next attempt, so a refusal is not
   silently cached as a grant.
6. Failing test: global settings mtime is unchanged across an approval.
7. Run the focused files and confirm each fails for the right reason.

**Design note.** The approver is supervisor-owned per ADR 0023, found while reading the
credential channel for this task: that channel has no peer authentication, so any
descendant in the namespace can reach its socket. An escalation channel of the same shape
would let a build script self-approve a host. The child yields the terminal; it never
decides.

### SDE.5: Implement interactive network escalation

**Files:**

- Modify: `packages/coding-agent/src/core/sandbox/rpc/`
- Modify: `packages/coding-agent/src/core/sandbox/network-proxy.ts`
- Modify: `packages/coding-agent/src/core/sandbox/linux-backend.ts`
- Modify: `packages/coding-agent/src/modes/interactive/`
- Modify: `docs/adr/0005-sandbox-boundary-guarantees.md`

1. Add a host-request frame carrying one concrete host, never a retry token.
2. Make the proxy's allowlist a mutable per-session set instead of the array captured at
   `linux-backend.ts:127`.
3. Render the prompt from the supervisor, reading the answer from `/dev/tty`, naming the
   exact host and the global settings key that would make it permanent. The child is asked
   to stop drawing over the channel and takes no part in the decision.
4. Amend ADR 0005 to record that the deferral's stated prerequisite was met by
   `core/sandbox/rpc/` on 2026-08-22, that headless remains deny, and to cite ADR 0023.
5. Run the focused files, then `npm test`, then commit and record the SHA.

### SDE.6: Prove the git credential channel

**Files:**

- Create: `packages/coding-agent/test/sandbox/git-credential-channel.test.ts`
- Read: `packages/coding-agent/src/core/sandbox/rpc/credential-proxy.ts`

1. Failing test: a push succeeds with no credential byte anywhere under
   `<workspace>/.apex-code/`, asserted by walking the tree after the push.
2. Failing test: a `get` for a host other than the one requested is refused and audited.
3. Failing test: every grant appears in the violation tail naming its host.
4. Run and confirm the failures are the missing helper and the missing service.

### SDE.7: Implement the git credential channel

**Files:**

- Create: `packages/coding-agent/src/core/sandbox/rpc/git-credential-helper.ts`
- Create: `packages/coding-agent/src/core/sandbox/rpc/git-credential-proxy.ts`
- Modify: `packages/coding-agent/src/core/sandbox/cli-launch.ts`
- Modify: `packages/coding-agent/src/core/sandbox/violations.ts`
- Modify: `docs/adr/0015-host-owned-credential-handoff.md`

1. Implement the helper against git's `get`/`store`/`erase` stdin protocol, relaying over
   the socket.
2. Answer `get` in the supervisor from the host's real helper or host `gh` token, scoped
   to the requested host only.
3. Set `credential.helper` inside SDE.2's synthesized config.
4. Amend ADR 0015 to extend host-owned handoff to a second credential class.
5. Run the focused file, then `npm test`, then commit and record the SHA.

### SDE.8: Prove writable roots and the opt-out

**Files:**

- Modify: `packages/coding-agent/test/sandbox/cli-launch.test.ts`
- Modify: `packages/coding-agent/test/sandbox/linux-backend.test.ts`
- Modify: `packages/coding-agent/test/sandbox/macos-backend.test.ts`

1. Failing test: `--add-dir` makes exactly that path writable in a real child.
2. Failing test: the same path in `.apex-code/settings.json` makes nothing writable.
3. Failing test: `--sandbox danger-full-access` requires confirmation and prints a banner.
4. Run and confirm the failures are the single-string policy and the unparsed flags.

### SDE.9: Implement writable roots and the opt-out

**Files:**

- Modify: `packages/coding-agent/src/core/sandbox/policy.ts`
- Modify: `packages/coding-agent/src/core/sandbox/linux-backend.ts`
- Modify: `packages/coding-agent/src/core/sandbox/macos-backend.ts`
- Modify: `packages/coding-agent/src/cli.ts`, `packages/coding-agent/src/cli/args.ts`
- Modify: `docs/adr/0005-sandbox-boundary-guarantees.md`

1. Keep `SandboxPolicy.workspace` singular and add `additionalWritableRoots` beside it.
   The spec sketched a flat `workspaceRoots` list; that turned out to be wrong. State,
   sessions, the concurrency lease, and the child's cwd are all anchored to one directory,
   and a flat list would have made the first element load-bearing by position. The field is
   required rather than optional, so every construction site says what it means.
2. Parse both flags in `cli.ts` from `process.argv` only, before the supervisor exists.
3. Amend ADR 0005 to retire "an opt-out is not introduced in Phase 2b".
4. Run `npm test`, then commit and record the SHA.

### SDE.10: Prove per-command escalation

**Files:**

- Create: `packages/coding-agent/test/sandbox/command-escalation.test.ts`

1. Failing test: an escalated command succeeds while the same operation, retried in the
   original child, is still denied.
2. Failing test: both children derive their argv from one builder, asserted by changing
   the builder and observing both.
3. Failing test: headless modes deny without prompting.

### SDE.11: Implement per-command escalation

**Files:**

- Create: `packages/coding-agent/src/core/sandbox/rpc/command-proxy.ts`
- Modify: `packages/coding-agent/src/core/sandbox/linux-backend.ts`, `macos-backend.ts`
- Create: `docs/adr/0023-per-command-sandbox-escalation.md`

1. Extract one argv builder per backend so the second child cannot drift from the first,
   which is the divergence ADR 0010 exists to prevent.
2. Spawn the escalated child from the supervisor; stream output back over the channel.
3. Write the ADR: two boundaries in one session is a launch-architecture change. It is
   `docs/adr/0024-per-command-sandbox-escalation.md`, not 0023 as this plan first said,
   because 0023 was taken by the escalation-authority decision U3 surfaced.
4. Run `npm test`, then commit and record the SHA.

### SDE.12: OS-boundary permission profiles

**Files:**

- Modify: `packages/coding-agent/src/core/settings-manager.ts`
- Modify: `packages/coding-agent/src/cli.ts`, `packages/coding-agent/src/cli/args.ts`
- Modify: `packages/coding-agent/test/sandbox/cli-launch.test.ts`

1. Failing test first: a profile named only in project settings has no effect on the
   launch contract.
2. Add the named profile shape and `--permission-profile`, resolved from global settings
   only, per ADR 0016.
3. Run `npm test`, then commit and record the SHA.

### SDE.13: Verify and close

**Files:**

- Modify: `docs/specs/2026-08-28-sandbox-delegation-and-escalation.md`
- Modify: `docs/roadmap.md`
- Delete: `docs/plans/2026-08-28-sandbox-delegation-and-escalation.md` after completion

1. Run `npm run check`.
2. Run `npm test`.
3. Confirm the sandbox suite ran against a real `bwrap` child on `ubuntu-latest` and a
   real `sandbox-exec` child on `macos-latest`, not a stubbed backend.
4. Walk a real session end to end: commit, push, and a refused host approved at the prompt.
5. Set the spec's Status to `Active`, link it from the roadmap, and delete this plan.
