# ADR 0027 — `AgentHarness` is not part of Apex Code's public API

**Status:** Accepted · **Date:** 2026-09-01

`apex-code-agent-core` re-exports the inherited upstream scaffold class
`AgentHarness` from its public index. The class is compile-complete but
deliberately unfinished: twenty-two methods reject with
`HarnessNotImplemented`, `create` throws on any session that already has
records, and its `hooks` and `events` registries throw on `.on()`. Nothing in
either package consumes it — no source file, test, or example imports the
symbol; its only consumers are the re-export itself and its own scaffold test,
which imports the module relatively. An external audit flagged it as a trap:
the only thing in the published surface named `hooks` is a registry that
throws when subscribed to.

Upstream's intent for the module is serious — `packages/agent/docs/harness.md`
is a full implementation specification for a durable, lane-based harness API,
and upstream promoted the class from an experimental entrypoint to the default
export. Apex inherited that promotion. That intent is respected here as
intent, not as an obligation to publish: Apex's own runtime model
(`AgentSession`, the daemon, the session tree) is the harness surface this
product ships, and exporting a parallel, mostly-throwing one invites exactly
the misuse the export exists to avoid.

**`AgentHarness` is not part of Apex Code's public API. The index re-export is
removed; the module, its scaffold test, and upstream's design document remain
in the tree untouched.**

Concretely:

- `packages/agent/src/index.ts` drops the single `export * from
  "./harness/agent-harness.ts"` line. Every other `harness/*` export stays —
  compaction, system prompt, skills, telemetry, and messages are live
  dependencies of the coding agent.
- The module stays compiled and its scaffold test stays green, so the upstream
  merge surface is unchanged: a file that is edited upstream still merges
  cleanly, because the fork deletes nothing from it.
- A public-API pin in `packages/agent/test/` fails if `AgentHarness` reappears
  in the index namespace, so the decision cannot be reversed by an accidental
  `export *`.
- Pre-alpha consumers lose the export; the changelog records it under
  `[Unreleased]`.

If a durable-harness API is ever designed for Apex Code, it gets a spec first
(the existing design document is prior art to evaluate, not a commitment to
carry), and re-exporting — or replacing — is one line behind that spec.

The cost is accepted: a pre-alpha consumer exploring the published surface
loses access to an API that throws on nearly every use, which is the trap
working as designed in reverse.
