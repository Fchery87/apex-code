# PR #33 follow-ups: credential writes, supervisor launch cost, review leftovers

**Status:** Active — credential channel in at `0aa2b380e`; ADR/changelog/spec included; root `npm test` pending; L and F open

This plan builds out the three follow-ups left open after PR #33 merged (`b64791a84` on the
rewritten history). None carries a new roadmap phase. Task identifiers are `C.n`
(credential channel, spec `docs/specs/2026-08-22-supervisor-mediated-credential-writes.md`),
`L.n` (supervisor launch cost), and `F.n` (review leftovers). Work proceeds test-first at
the seams the spec names.

A previous session left aborted work-in-progress in the tree (debug file writes in
`child-entry.ts`, an `AuthStorage.create` monkey-patch, a socket path re-resolved in the
Linux backend so the child pointed at a socket nobody listened on). That WIP was reverted
before this plan started; its useful shape — proxy/client split, newline-JSON protocol —
is rebuilt here rather than salvaged.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| C.1 Channel protocol: supervisor-side credential writer and child-side client | Landed | 0aa2b380e | Red: `!command` value, `$VAR`, `${VAR}` refused and audited; literal accepted; delete; read/list stay local and read-only. Green: `core/sandbox/rpc/{credential-proxy,credential-client}.ts` unit tests against a real unix socket in a scratch temp dir, no OS sandbox needed. |
| C.2 Supervisor wiring: launch contract, Linux bind, macOS projection | Landed | 0aa2b380e | Red: launch without `credentialChannel` must not add a bwrap bind, a Seatbelt line, or an env var. Green: `SandboxLaunch.credentialChannel`; linux-backend binds host→child under `/home`; macos-backend adds `(allow network-outbound (remote unix-socket ...))` with the canonicalized path and passes the env; cli-supervisor creates/closes the proxy when `authPath` is set. Unit tests use the existing `spawnChild` injection seams. |
| C.3 Child wiring: the session runtime uses the channel store | Landed | 0aa2b380e | Red: `createAgentSessionServices` outside a sandbox builds the default store; with `APEX_CREDENTIAL_PROXY_PATH` set it builds the channel store. Green: `ModelRuntime.create` receives the store via its existing `credentials` option; no monkey-patching, no `child-entry.ts` change. |
| C.4 Live verification through a real sandboxed turn | Landed | 0aa2b380e | Extend `test/sandbox/credential-handoff.test.ts`: raw fs write to `auth.json` still refused (mount unchanged); channel write lands in host `auth.json`; refused value recorded in the violation tail. Gate generalized to any enforcing platform so macOS CI proves the Seatbelt projection. |
| C.5 Closure: gates, ADR 0015 amendment, changelog, spec status | In progress — ADR/changelog/spec landed in `0aa2b380e`; `npm run check` green; root `npm test` deferred to the end of all tasks | — | Narrow suites, `npm run build`, `npm run check`, root `npm test`. ADR 0015 gains a dated amendment (the child can now request constrained writes; the read-only handoff itself is unchanged). CHANGELOG `[Unreleased]` entry. Spec status Draft → Implemented. Plan deleted. |
| L.1 Supervisor launch cost: measure, cut `settings-manager` from the launch path | Not started | — | `node scripts/measure-supervisor-imports.mjs --dist` before and after, numbers pasted into the plan record; the fix must not duplicate settings-parsing logic (ADR 0010 drift risk). |
| F.1 Verify the `.apex-code` gitignore carve-out is complete | Not started | — | `git ls-files .apex-code` lists only intentionally-versioned paths; no runtime path tracked or dirty after a run. Expected no-op — the carve-out landed in `33c6f99cd`; this task exists to verify and record it. |
| F.2 `7209` breadth: prove the harness scrub covers every provider credential variable | Not started | — | Enumerate the credential env vars the provider registry actually reads (pi-ai `env-api-keys`); a test pins that the suffix/name list in `test/suite/harness.ts` covers all of them, so a new provider's key is covered the day it is added. |
| F.3 `web_search` snippet word-boundary trim | Not started | — | Red: a highlight longer than the cap ends mid-word today. Green: trim to the last word boundary, test on the adapter seam. |

## Order notes

The user-specified order is C → L → F and is kept. Two notes:

- C.2 and C.3 are separable but land in that order: the client class (C.1) is testable
  standalone, C.3 is a one-seam wiring change, and C.4 needs all three.
- F.1 is a verification of already-landed work, not new work. If it finds a gap, the gap
  becomes the task, not the verification.
