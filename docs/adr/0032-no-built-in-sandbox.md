# ADR 0032 — Apex Code ships no OS boundary

**Status:** Accepted · **Date:** 2026-09-12

Apex Code no longer contains an operating-system sandbox. The Bubblewrap and Seatbelt
backends, the supervisor and its child launch, the egress allowlist proxy, the host
approval prompt, the supervisor-mediated git credential channel, the sandbox profiles,
and the SDK containment contract are deleted. A session is an ordinary local process that
runs with the permissions of the account that started it.

This supersedes ADR 0005 (what the boundary guaranteed), ADR 0015 (the host-owned
credential handoff), ADR 0016 (trust-first supervisor policy), ADR 0023 (escalation
authority), ADR 0024 (per-command escalation), and ADR 0031 (the SDK sandbox contract).
Each describes a mechanism that no longer exists. They are marked `Superseded` rather
than deleted, so the reasoning survives its own implementation.

## Decision

Containment is the operator's boundary, not the harness's. To run untrusted code, an
unreviewed working tree, or an unattended session, run the CLI inside a container, a VM,
or a remote sandbox holding only the files and credentials the task needs. The harness
documents that pattern and does not implement it.

The permission gate is untouched, and it is a different layer. ADR 0004's rule model, its
eight-source precedence, and its five modes still decide every tool call at
`beforeToolCall`. It runs in the process the user started, it is platform-independent, and
it is not a containment boundary. Removing it is a separate decision this ADR does not
make.

Project trust is also untouched. It is upstream Pi's guard against a cloned repository
changing settings and extensions before you approve it, and `CONTEXT.md` has always
recorded it as "not a sandbox and not a permission system".

## Why

Three reasons, in order of weight.

**The boundary asked a question that had one real answer.** A session needing a host
outside `network.allowedHosts` stopped and asked. The prompt's own grant message told the
user to edit global settings, so the decision it interrupted was already made. It read as
friction, not as a decision. It could not be suppressed from inside a session, because the
entire design was that the enforcement layer is not a layer a session can change.

**A one-maintainer project cannot carry it.** ADR 0014 records sole-maintainer production
operations. The boundary carried two platform backends, a CI `sysctl` workaround for
Ubuntu's unprivileged user-namespace restriction, a macOS guarantee that Phase 2b itself
recorded as categorically weaker than Linux's, unresolved holes in Apple Events and
code-signing behavior, a nine-task repair after whole-CLI launch silently disabled
user-scope skill discovery, and a remediation spec written after a third-party audit found
real escape paths. Every one of those was necessary work. None of them made the boundary
cheap to own.

**The alternatives show the friction was optional.** Three comparable harnesses were read
before this decision. Prime Agent ships no boundary and instructs users to run it inside a
devcontainer, a VM, or a remote machine. Atomic states in its security doc that it "does
not include a built-in sandbox" and offers Docker, Gondolin, and OpenShell as its three
routes to containment. Codex does enforce a boundary, but exposes `network_access` and
`danger-full-access` so that configuration or a session can widen it. Apex Code was the
only one of the four that both enforced a boundary and refused to let a session widen it.
That is exactly why it was the only one that asked.

Deleting Apex-only code also lowers fork divergence, so ADR 0003's patch-surface ceiling is
not threatened by this change.

## Consequences

- Writes outside the workspace succeed. The write boundary is gone, and `--add-dir` is
  meaningless without it, so `--add-dir` is deleted rather than kept.
- `git push` uses the host's own git credentials again. The supervisor-mediated release
  path existed only to serve the read-only credential mount. This is a capability gain
  inside a session, and it belongs in the release note rather than in a bug report.
- The host home directory is visible to a session again. It can read `~/.ssh`, `~/.aws`,
  and shell history.
- The `sandboxEnforced` field on the persisted child-run record is retained and left
  optional. A session written before this change still parses, and nothing sets the field
  true now. Removing it would be a session-format change, and ADR 0006's migration
  guarantee is not something this decision needs to spend.
- A session no longer runs in a child process. The supervisor, the terminal handoff, and
  the policy snapshot existed to serve the sandboxed launch and go with it.
- Skill discovery returns to its host-side roots, because nothing repoints `HOME` or the
  agent directory any more. ADR 0021's name-only catalog stays, since it is a token-budget
  decision and not a containment one.
- Reversal is a Phase-2-sized effort. The deleted code, the five superseded specs, and the
  six superseded ADRs all remain reachable in git history.

## Rejected alternatives

**Keep the boundary and default it off.** This is the smallest diff and it preserves the
option. It loses on honesty. A security boundary that nothing exercises is a claim the
repository cannot check, which is the failure class
`2026-08-29-documented-surfaces-that-do-not-exist.md` was written to remove. It also keeps
the maintenance surface without the benefit.

**Keep the boundary and remove only the prompt.** This fixes the reported symptom and
leaves a boundary that refuses silently, which is worse than one that asks. A refusal a
user cannot answer becomes a failure they have to debug.

**Keep the prompt and delete only the mounts and the network enforcement.** The prompt was
the part the user wanted gone, and it was the only part that could not be tested without a
human. Keeping it while removing what it asked about inverts the reason it existed.

**Shim the removed flags.** Accepting `--sandbox` and ignoring it would leave a
security-shaped word in the CLI of a binary that has no security boundary.
