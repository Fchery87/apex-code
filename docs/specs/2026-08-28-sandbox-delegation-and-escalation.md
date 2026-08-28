# Spec: Sandbox delegation and escalation

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Status | `Active` |
| Created | `2026-08-28` |
| Last updated | `2026-08-28` |
| Roadmap phase | `none — follow-up to Phase 2b (OS sandbox)` |
| Tracking issue/PR | `none` |
| Compatibility posture | Preserves compatibility for units 1 through 4 and 6. No session, settings key, mount, or allowlist behaviour that works today stops working; each of those units turns a current hard failure into a success, and a user who configures nothing sees exactly today's boundary. Unit 5 is the one real break, and it is a break in the *claim* rather than the code: ADR 0005 currently states that an opt-out is not introduced, and shipping `--sandbox` retires that sentence. Unit 7 adds a new settings surface that is inert when unset. The CLI surface grows by three flags and never changes the meaning of an existing one. |

## Executive summary

Apex Code's OS sandbox implements denial completely and delegation barely. A session
cannot commit with the user's identity, cannot push to GitHub, and cannot ask for a host
it needs, because the boundary is decided once before the child starts and offers no way
to widen it deliberately. This spec adds the missing half in seven units: a synthesized
git identity projection, reconciled documentation, interactive network escalation over
the existing supervisor RPC channel, a supervisor-mediated git credential channel shaped
like ADR 0015's, explicit writable roots with a full-access opt-out, a per-command
escalation channel, and named OS-boundary profiles. The host home stays hidden and
project settings stay unable to widen their own boundary throughout.

## Context and motivation

- `docs/adr/0005-sandbox-boundary-guarantees.md` — the boundary this extends. It defers
  interactive escalation, and names the exact prerequisite: "supervisor/child IPC can
  carry a concrete blocked-host request without granting an unrestricted retry". It also
  states that an opt-out is not introduced in Phase 2b.
- `docs/adr/0015-host-owned-credential-handoff.md` — the pattern units 1 and 4 follow.
  Its 2026-08-22 amendment built exactly the IPC that ADR 0005 was waiting for, ten days
  after ADR 0005 recorded the deferral. Nobody revisited the deferral.
- `docs/adr/0016-trust-first-supervisor-policy.md` — the constraint every unit here obeys.
  Supervisor policy comes only from the runtime environment and explicit user or
  maintainer inputs, never from project files.
- `docs/specs/2026-08-22-supervisor-mediated-credential-writes.md` — the design this
  generalizes from one credential class to two, plus a command class.
- `docs/specs/2026-08-12-os-sandbox.md:576` — the record of an unlisted `github.com`
  request returning CONNECT 403, and `:565` for why `--tmpfs /home` hides host tooling.
- `docs/roadmap.md:257` — lists interactive escalation inside Phase 2b's scope, which
  contradicts ADR 0005's deferral. Unit 2 reconciles this.

The immediate trigger was a user attempting an ordinary commit and push from inside a
session. The commit failed with `Author identity unknown`, and the push failed with
`CONNECT tunnel failed, response 403`. Both are working as designed. Neither has a
remedy inside the product.

## Current state

The Linux boundary, as built:

- `packages/coding-agent/src/cli.ts:30` sandboxes every command that can construct an
  agent session. `requiresSandboxedChild` (`core/sandbox/cli-launch.ts:17`) exempts only
  the maintenance subcommands and metadata flags. There is no opt-out flag.
- `cli.ts:60` passes `workspace: process.cwd()` as the single writable root.
  `SandboxPolicy.workspace` (`core/sandbox/policy.ts:5`) is one string, not a list.
- `core/sandbox/linux-backend.ts:196` builds the `bwrap` argv. `--ro-bind / /` makes the
  host root readable, `--tmpfs /home` replaces the entire home tree with an empty
  filesystem, and `--unshare-net` leaves the child with no network interface beyond a
  private loopback.
- `cli-launch.ts:329` repoints `HOME` and `TMPDIR` at
  `<workspace>/.apex-code/sandbox-state`, with the four XDG variables beneath it.
  Consequently `git` resolves global config to an empty directory, and so does `gh`.
- `buildChildEnvironment` (`cli-launch.ts:220`) filters the child environment to
  `SAFE_CHILD_ENVIRONMENT_KEYS` plus named provider and tool credential keys.
  `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, and `SSH_AUTH_SOCK` are all absent.
- `resolveSupervisorAllowedHosts` (`cli-launch.ts:41`) reads global settings only, with
  `projectTrusted: false`, per ADR 0016. `resolveDefaultAllowedHosts`
  (`core/sandbox/default-hosts.ts:64`) returns the model-provider hosts plus
  `registry.npmjs.org`. Neither `github.com` nor `api.github.com` is on it.
- The allowlist is fixed for the session's life. `createSandboxNetworkProxy` receives
  `launch.policy.allowedHosts` once at `linux-backend.ts:127` and never consults it again.
- A refusal is recorded in `SandboxViolationStore` (`core/sandbox/violations.ts:14`), a
  bounded in-memory tail printed on exit. It reports; it does not prompt.
- The RPC precedent exists and works. `core/sandbox/rpc/` is 652 lines of framed,
  byte-bounded, audited Unix-socket protocol between supervisor and child, projected into
  the child at `linux-backend.ts:210` and advertised as `APEX_CREDENTIAL_PROXY_PATH`.
- Single-file read-only projection exists. `readOnlyMountArguments`
  (`linux-backend.ts:35`) emits `--tmpfs <parent> --perms 0400 --file <fd> <target>` for a
  file, and `linux-backend.ts:179` opens each one before the spawn.
- `bypassPermissions` (`core/permissions/store.ts:22`) is one of five tool-gate modes. It
  runs inside the child at `beforeToolCall`. The mounts and the allowlist are fixed by the
  supervisor before the child exists, so no in-child mode can reach either.

None of the above is forked Pi behaviour. The whole sandbox is Apex-original, so ADR 0003
merge cost does not apply to any unit here.

## The problem

**1. A session cannot author a commit.** `git` is readable at `/usr/bin/git` through the
read-only root bind, but its identity is not. Global config resolution walks
`$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config`, and both now land inside an empty
sandbox state directory. Every fresh workspace reproduces `Author identity unknown`. The
only surviving level is repository-scope `.git/config`, which the user must set by hand,
per repository, forever.

**2. A session cannot reach GitHub, and cannot ask to.** The proxy knows the exact refused
host at the moment it answers 403. It records that host and discards it. The user's only
remedy is to exit the session, edit global settings, and restart, because the allowlist is
captured at launch.

**3. There is no safe place to put a GitHub credential.** Authenticating `gh` inside the
sandbox writes `hosts.yml` into `.apex-code/sandbox-state/config/gh/`, which is a live
OAuth token inside the repository workspace. ADR 0015 rejects precisely this shape for
provider credentials, on the grounds that cleanup and disclosure become best-effort.
Gitignoring it prevents committing and nothing else. The alternative, exposing the host
home, would surface SSH keys and every unrelated project alongside the one token wanted.

**4. A refusal is terminal.** ADR 0005 defers escalation, so a denied filesystem or
network operation ends the attempt. The user's only continuation is to leave the harness.
This is the difference users perceive as Apex being restrictive, and it is a delegation
gap rather than a containment one.

**5. The documentation contradicts itself.** `README.md:352` says `/share`'s gist
credentials live in the host home the sandbox hides, and instructs the user to run `gh`
outside the session. `README.md:472` says `/share` "uses your authenticated GitHub CLI to
create a secret Gist". `docs/roadmap.md:257` puts interactive escalation in Phase 2b's
scope while ADR 0005 defers it.

## Goals

- [ ] A commit made inside a fresh sandboxed session on a workspace with no
      repository-scope identity is authored with the host's `user.name` and `user.email`.
- [ ] No file written by any unit contains a credential inside `<workspace>/.apex-code/`,
      asserted by a test that greps the sandbox state tree after an authenticated push.
- [ ] A request to a host absent from the allowlist raises a prompt naming that exact
      host, and approving it permits that host and no other for the remainder of the
      session only.
- [ ] Approving a host does not write to global settings, verified by asserting the
      settings file's mtime is unchanged across an approval.
- [ ] `git push` to an approved GitHub remote succeeds inside a session with no
      credential file anywhere under the workspace.
- [ ] The supervisor's violation tail records every credential grant, every host
      approval, and every refusal, each naming the host it applied to.
- [ ] `apex-code --add-dir <path>` makes exactly that path writable, and a path supplied
      through `.apex-code/settings.json` makes nothing writable.
- [ ] `apex-code --sandbox danger-full-access` runs unsandboxed after an explicit
      confirmation, and prints a banner naming what is no longer enforced.
- [ ] A denied filesystem operation raises a prompt; approving it runs that one command in
      a separate supervisor-spawned child, and the original child's namespace is unchanged,
      asserted by re-running the same operation in the original child and seeing it denied.
- [ ] Every unit's behaviour is asserted against a real `bwrap` child on `ubuntu-latest`
      and a real `sandbox-exec` child on `macos-latest`, not against a stubbed backend.
- [ ] `README.md` and `docs/roadmap.md` each state one thing about `/share` credentials
      and about escalation respectively, matching the shipped behaviour.

## Non-goals

- [ ] **Exposing the host home, in whole or in part, on either backend.** This is the
      property the boundary exists to provide, and units 1 and 4 exist specifically so
      that no unit ever needs it. `isHomeOrAncestorOfHome` (`cli-launch.ts:88`) already
      refuses a skill root that resolves onto it, and that refusal stays.
- [ ] **Projecting the host's real `~/.gitconfig`.** A real one can carry
      `credential.helper` invocations and `url.insteadOf` entries containing tokens.
      Unit 1 synthesizes a two-key file instead, so the projection cannot carry anything
      the user did not intend to share.
- [ ] **Persisting an approved host.** An approval lasts for the session. Persistence
      would recreate the widening ADR 0016 forbids, one prompt at a time, and a user who
      wants a permanent entry already has global settings.
- [ ] **Letting project settings configure any of this.** Every new input is a CLI flag or
      a global setting, parsed outside project resources, per ADR 0016. A repository must
      not be able to grant itself a writable root, a host, or a credential.
- [ ] **Copying Codex's network model.** Codex exposes one boolean for the whole sandbox.
      Apex's per-host, port-pinnable allowlist is strictly finer, and unit 3 adds the
      missing prompt rather than replacing the mechanism with a coarser one.
- [ ] **Moving session state out of the workspace.** ADR 0015 marks workspace-resident
      sessions as deliberate until a canonical persistence design exists. Nothing here
      revisits that, and unit 6 must not become a back door to it.
- [ ] **Windows support.** Unchanged and still unsupported, per ADR 0005.

## Proposed solution

Seven units. Each lands independently and each ends in its own check. Unit numbers are
identifiers, not a sequence, per `AGENTS.md`.

### U1 — Synthesized git identity projection

| Component | Change | File(s) |
| --- | --- | --- |
| Identity resolution | Read host `user.name` and `user.email` before the child exists | `core/sandbox/git-identity.ts` (new) |
| Projection | Write a two-key gitconfig into a supervisor-owned `0700` temp dir, pass it through the existing `readOnlyFiles` path | `core/sandbox/cli-launch.ts`, `cli.ts` |
| Child wiring | Set `GIT_CONFIG_GLOBAL` in the child environment to the projected path | `core/sandbox/cli-launch.ts:318` |

The supervisor runs unsandboxed and can already read the host home, which is how
`authPath` and the skill roots are resolved today. Synthesizing rather than projecting is
what keeps a host `credential.helper` line out of the child. The file must live in its own
directory for the reason in Risks.

### U2 — Documentation reconciliation

| Component | Change | File(s) |
| --- | --- | --- |
| `/share` credentials | Make `:472` agree with `:352` until U4 lands, then make both describe the channel | `README.md` |
| Escalation scope | State that escalation is deferred per ADR 0005, and amend when U3 lands | `docs/roadmap.md:257` |
| Boundary clarity | State that `bypassPermissions` is a tool gate and does not affect the OS boundary | `README.md`, `docs/user-guide.md` |

### U3 — Interactive network escalation

| Component | Change | File(s) |
| --- | --- | --- |
| Protocol | Add a host-request frame to the existing framed protocol | `core/sandbox/rpc/` |
| Proxy | On refusal, request approval instead of recording and returning 403 | `core/sandbox/network-proxy.ts` |
| Allowlist | Make the proxy's allowlist a mutable per-session set rather than a captured array | `core/sandbox/network-proxy.ts`, `linux-backend.ts:127` |
| Prompt | Rendered by the **supervisor**, reading the answer from `/dev/tty` itself | `core/sandbox/rpc/escalation-proxy.ts` (new) |
| Child role | Yield the terminal on request and redraw afterwards. It never decides | `modes/interactive/` |
| Headless | Deny without prompting in print, JSON, and RPC modes, per ADR 0005 | `core/sandbox/network-proxy.ts` |

The request carries one concrete host. Approval adds that host and nothing else. This is
the constraint ADR 0005 named, satisfied rather than worked around, and it is possible
only because the refusal happens in a userspace proxy Apex owns.

**Who renders the prompt is a security property, not a UI choice.** See the amendment
below.

### U4 — Supervisor-mediated git credential channel

| Component | Change | File(s) |
| --- | --- | --- |
| Helper | A small binary speaking git's `get`/`store`/`erase` protocol on stdin, relaying over the socket | `core/sandbox/rpc/git-credential-helper.ts` (new) |
| Projection | Project the helper read-only and set `credential.helper` in U1's synthesized config | `core/sandbox/cli-launch.ts` |
| Supervisor service | Answer `get` by invoking the host's real helper or reading the host `gh` token, scoped to the requested host | `core/sandbox/rpc/git-credential-proxy.ts` (new) |
| Audit | Record every grant and refusal with the host it applied to | `core/sandbox/violations.ts` |

The token is never written into the workspace, never placed in the child environment, and
never returned for a host other than the one in the request. This is ADR 0015's accepted
posture applied to a second credential class, so it extends that ADR rather than
revisiting it.

### U5 — Explicit writable roots and a full-access opt-out

| Component | Change | File(s) |
| --- | --- | --- |
| Policy shape | `SandboxPolicy` gains a required `additionalWritableRoots` beside the singular `workspace` | `core/sandbox/policy.ts:5` |
| Backends | Emit one `--bind` per root, and the Seatbelt equivalent | `linux-backend.ts`, `macos-backend.ts` |
| CLI | `--add-dir <path>` (repeatable) and `--sandbox <mode>` | `cli.ts`, `cli/args.ts` |
| Opt-out | `danger-full-access` skips the supervisor entirely, behind an explicit confirmation and a persistent banner | `cli.ts:30` |

Both flags are parsed in `cli.ts` before the supervisor is constructed and read only from
`process.argv`, never from settings, per ADR 0016.

### U6 — Per-command escalation channel

| Component | Change | File(s) |
| --- | --- | --- |
| Protocol | Add a command-escalation frame carrying one command and the one grant it needs | `core/sandbox/rpc/` |
| Supervisor | Spawn a second, differently-mounted child for that one command; stream output back | `core/sandbox/rpc/command-proxy.ts` (new) |
| Argv construction | Extract the `bwrap` and Seatbelt argv builders so both children derive from one source | `linux-backend.ts`, `macos-backend.ts` |
| Prompt | Render the request; deny without prompting in headless modes | `modes/interactive/` |

A filesystem denial happens in the kernel and cannot be re-asked in place: the syscall has
already failed, and `bwrap` mounts are fixed for a namespace's life. The escalation must
therefore come from outside the boundary, which is where the supervisor already is. The
original child's namespace is never modified. Each escalated command is a separate,
individually approved, individually audited process.

### U7 — OS-boundary permission profiles

| Component | Change | File(s) |
| --- | --- | --- |
| Profile shape | A named, saved combination of writable roots, allowed hosts, and escalation policy | `core/settings-manager.ts` |
| CLI | `--permission-profile <name>`, resolved from global settings only | `cli.ts`, `cli/args.ts` |

Apex's five tool-gate modes and eight-source precedence (ADR 0004) govern the child's
`beforeToolCall` seam. A profile here governs the supervisor's launch contract instead.
The two are deliberately separate surfaces, and U2's documentation must say so, because
conflating them is the misreading that makes `bypassPermissions` look like a sandbox
escape.

### Seam invariants

`beforeToolCall` is untouched. No unit changes what the tool gate sees or when it runs;
U6's escalation is requested *after* the gate has already allowed a call and the OS
boundary has then refused it. Evidence capture is untouched. The one-projection rule of
ADR 0010 is the reason U6 extracts a single argv builder rather than writing a second one.

## Amendment (2026-08-28): the escalation prompt must be supervisor-owned

Found while implementing U3, before any escalation code was written.

The existing credential channel performs **no peer authentication**. Its socket is
bind-mounted at a fixed path inside the child's namespace, and any descendant process in
that namespace can connect to it. ADR 0015's amendment lists what does constrain it --
literal secrets only, byte-bounded frames, an audited tail -- and peer identity is not on
that list. That is defensible for credential writes, whose worst case is writing a literal
secret into a file the child already reads.

It is not defensible for host escalation. An escalation channel of the same shape would
let any process inside the boundary send "the user approved github.com", and the
supervisor would have no way to tell that frame from one the human actually caused. The
grant would be forgeable by exactly the code the boundary exists to contain -- a build
script, a git hook, a postinstall, or repository content steering the agent. The allowlist
would become advisory.

So the child cannot be the one that decides, and it therefore cannot be the one that
prompts either, because a prompt whose answer travels back over the same forgeable channel
is not evidence of anything. **The supervisor renders the prompt and reads the answer from
`/dev/tty` itself.** The child's only role is to stop drawing while that happens, which it
is asked to do over the channel.

What this buys: a forged "please suspend" frame gains an attacker nothing, because the
human still has to type at a prompt the supervisor owns. The worst case of a child that
refuses to yield the terminal is a prompt drawn over by TUI output, which is a legibility
failure, not a grant. The design fails safe in the direction that matters.

This is recorded as `docs/adr/0023-supervisor-owned-escalation-authority.md`, per this
template's rule that an irreversible decision surfacing during implementation becomes its
own ADR rather than being folded into the spec.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `README.md:352-354` `/share` "run `gh gist create` outside it" instruction | doc | Superseded by U4. The workaround stops being the answer once the credential channel exists. |
| `docs/roadmap.md:257` "interactive escalation" in the 2b scope cell | doc | Corrected by U2 to state the deferral, then amended by U3 to state it shipped. |
| ADR 0005's "an opt-out is not introduced in Phase 2b" | doc | Retired by U5's amendment. The sentence is accurate today and must not silently become false. |
| ADR 0005's escalation deferral and its stated prerequisite | doc | Superseded by U3's amendment, which records that `core/sandbox/rpc/` satisfied the prerequisite on 2026-08-22. |
| `SandboxPolicy.workspace` as the only writable root | code | Joined by a required `additionalWritableRoots` in U5. The field itself survives: the spec originally proposed a flat `workspaceRoots` list, and implementation showed that was wrong, because state, sessions, the lease, and the child's cwd all need one distinguished directory rather than a positionally-significant first element. |
| The proxy's captured `allowedHosts` array | code | Replaced by a mutable per-session set in U3. |
| Repository-scope `user.name` / `user.email` as the documented workaround | behaviour | Retired by U1. It keeps working, because it is ordinary git, but it stops being necessary. |

## Risks

**A second `readOnlyFiles` entry in the same directory silently hides the first.**
`readOnlyMountArguments` (`linux-backend.ts:46`) emits `--tmpfs <parent>` for every file
projection. Two files sharing a parent mean the second `--tmpfs` remounts an empty
filesystem over the first. U1 is the first change to project a second file and would
trigger it by placing the synthesized gitconfig next to `auth.json` in
`~/.apex-code/agent/`. Mitigation is a dedicated `0700` directory per projected file, plus
a test that projects two files and asserts both are readable in the child. Signal if
missed: `git` reports no identity while provider auth still works, or the reverse
depending on argv order.

**U6's second child drifts from the first.** Two independently maintained mount-argv
builders is exactly the divergence ADR 0010 exists to prevent for tool contracts. A policy
tightening would land in one and not the other, and the escalated path is the one where
that matters. Mitigation is a single extracted builder, and a test asserting both children
derive from it. Signal: a mount or allowlist change whose test passes for the primary
child only.

**U4 grants a credential for a host the user did not intend.** A repository with a
submodule or an `insteadOf` rule pointing at a different forge can cause git to request
credentials for it. Mitigation is scoping every answer to the host in the request and
auditing each grant by host. Signal: a `get` in the violation tail naming a host the user
did not push to.

**U3 becomes a persistence request.** Users who approve the same host every session will
ask for "always allow", which is the widening ADR 0016 forbids, arriving one prompt at a
time. Mitigation is that the prompt names the global settings key that makes it permanent,
so the durable path is the explicit one.

**A unit lands on Linux only and the guarantee splits.** ADR 0005's macOS amendments
already record that macOS's network guarantee is categorically weaker, because it has no
private per-process loopback. Every unit must land in both backends or the boundary means
two different things. Mitigation is the `macos-latest` job that already exists. Signal: a
sandbox test green on `ubuntu-latest` and skipped on `macos-latest`.

**U5's opt-out relieves the pressure that gets U3 and U4 built.** If full access ships
first, the delegation work loses its forcing function and the product keeps the gap
permanently. Mitigation is ordering, in Rollout.

## Verification

Existing tests that must stay green, unmodified:

- `test/sandbox/default-hosts.test.ts` — recomputes the default host set from the provider
  registry and fails on drift.
- `test/sandbox/credential-handoff.test.ts` — pins the read-only credential projection.
- `test/restore-sandbox-env.test.ts`, `test/sandbox-terminal-size.test.ts`.

New coverage, one slice per unit, written test-first per `AGENTS.md`:

| Unit | Assertion | Backend |
| --- | --- | --- |
| U1 | Two projected files in separate directories are both readable in the child; a commit in a workspace with no repo-scope identity carries the host identity | real `bwrap` and `sandbox-exec` |
| U1 | A host `~/.gitconfig` containing `credential.helper` yields a projected file containing only `user.name` and `user.email` | unit |
| U3 | A refused host raises exactly one request naming that host; approval permits it and denies a second, different host | real child |
| U3 | Print, JSON, and RPC modes deny without prompting | unit |
| U3 | Global settings mtime is unchanged across an approval | unit |
| U4 | A push succeeds with no credential byte anywhere under `<workspace>/.apex-code/`, asserted by walking the tree | real child |
| U4 | A `get` for an unrequested host is refused and audited | unit |
| U5 | `--add-dir` makes one path writable; the same path in `.apex-code/settings.json` makes nothing writable | real child |
| U6 | An escalated command succeeds while the same operation, retried in the original child, is still denied | real child |
| U7 | A profile named only in project settings has no effect on the launch contract | unit |

`npm run typecheck` and `npm test` at the end of each unit. ADR 0005's Linux guarantee is
already exercised in CI following the 2026-08-13 `sysctl` fix, so the real-child
assertions above have a working harness to land in.

This spec serves no roadmap phase gate, so no replay-corpus metric applies.

## Rollout

Needs `docs/plans/2026-08-28-sandbox-delegation-and-escalation.md`, because seven units
across two platform backends, four ADR amendments, and a policy type migration need their
own status tracking.

Order is load-bearing rather than convenient:

1. **U1, then U2.** Small, no ADR change, and together they end the failure that
   prompted this spec.
2. **U3, then U4.** Where the actual product gap lives.
3. **U5.** Deliberately last of the first five. Shipping the escape hatch earlier removes
   the pressure that gets U3 and U4 built, which is the failure mode named in Risks.
4. **U6, then U7.** Only if filesystem escalation proves to bite in practice. Observe it
   rather than predict it.

ADRs required, each written before its unit lands:

| Unit | ADR action | Why |
| --- | --- | --- |
| U3 | Amend ADR 0005 | The deferral's stated prerequisite was met by `core/sandbox/rpc/` on 2026-08-22. Record that, and that headless stays deny. |
| U4 | Amend ADR 0015 | Extends host-owned credential handoff to a second credential class. |
| U5 | Amend ADR 0005 | Retires "an opt-out is not introduced in Phase 2b". |
| U6 | New ADR | Irreversible and contested: a second, differently-mounted child is a launch-architecture change, and it is the first time Apex runs two boundaries in one session. |
| U7 | Cite ADR 0016 | No new decision. Conformance statement only: profiles resolve outside project resources. |
