# ADR 0001 — Fork boundary: fork the agent, consume the provider layer

**Status:** Accepted · **Date:** 2026-08-08 · **Amended:** 2026-08-09 (package inventory corrected; graft shape decided — see Amendment)

Pi is a monorepo of MIT packages (`github.com/earendil-works/pi`). The two that matter
here are `pi-agent-core` (`packages/agent`, the `Agent` class and loop) and
`pi-coding-agent` (`packages/coding-agent`, tools, sessions, compaction, extensions,
CLI). A fork has to choose how much of that it owns, and the choice is hard to reverse
later — it determines the merge burden for the life of the project.

**Apex Code forks `pi-coding-agent` and `pi-agent-core`. Every other Pi package is
consumed, not forked.**

The forked half is exactly the half Apex Code changes. Permissions, sandboxing,
tool-result eviction, and deferred tool schemas all have to intercept below the
extension API — the roadmap's Phases 2 through 5 are not expressible as extensions,
which is why staying a pure extension layer was rejected. Owning the loop and the
tool/session layer is the minimum that makes them possible.

The consumed half is the half that needed no improvement. `pi-ai` covers 35 providers
across 9 API dialects, normalizes thinking levels, cache retention, and transports,
and lazily loads dialects so the import cost is one, not thirty-five. It is the
strongest component in any harness surveyed, and it is also the fastest-churning:
vendors ship models continuously, and every one is upstream's maintenance rather than
ours. Forking it would mean paying that cost forever to gain nothing Apex Code wants.
Apex Code's provider work — credential pooling, model roles, fallback chains, measured
routing (Phase 1) — sits *above* `pi-ai` and needs no changes inside it. Runtime
provider registration through `registerProvider()` already covers custom endpoints.

`pi-tui` is consumed for the same reason in miniature: two runtime dependencies, and
Apex Code has no quarrel with it.

Consequences, accepted deliberately:

- Apex Code is bounded by `pi-ai`'s public API. If something genuinely requires a change
  inside it, the response is an upstream contribution to Pi, not a local patch. A
  local patch to a consumed package is the failure mode this ADR exists to prevent —
  it converts a dependency into an unmanaged fork without anyone deciding to.
- Forked files should stay legible as a diff against upstream. Gratuitous
  restructuring of forked code raises the cost of every future merge; see ADR 0003
  for the ceiling that governs when that cost becomes decisive.
- `pi-agent-core` depends on `pi-ai` by semver range. Apex Code's fork of agent-core
  controls that range and is the single place the upstream provider version is
  pinned.

Revisiting this means crossing the ADR 0003 tripwire, not simply preferring more
control. "We could move faster if we owned it" is the argument this decision already
weighed and rejected.

## Amendment — 2026-08-09

Two facts, discovered when the fork was actually performed, that the original text got
wrong. The decision above is unchanged; its inventory and mechanism are corrected.

**Pi is ten packages, not four**, and `pi-coding-agent` depends on **five** of them at
runtime — `pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`, `pi-tui` — not the two
originally named. `pi-client` and `pi-protocol` join the consumed set on identical
terms. The full inventory lives in `docs/upstream-log.md` and is maintained there, not
here, so it cannot drift between two documents.

**The fork is a full-tree graft.** The whole monorepo is grafted at `v0.84.0` with
history, and upstream releases are taken with ordinary `git merge`. Subtree pulls and
hand-applied diffs were both rejected on measurement: one *patch* release moved 57
files and ~2,000 lines inside the two forked packages, and no cheaper merge mechanism
survives that rate. Deleting the consumed packages from the tree was also rejected —
it would manufacture a conflict on every upstream change to those paths, permanently.

So the consumed packages are present in the repository and **frozen**:

- CI asserts each is byte-identical to the upstream tag recorded in
  `docs/upstream-log.md`. This makes "do not patch consumed packages" a build failure
  rather than an honor-system rule, which is strictly stronger than the original
  wording of this ADR.
- Published Apex Code artifacts depend on the `@earendil-works/*` releases from npm.
  The in-tree copies exist for local development and for merge continuity, and are
  never what a user installs.
- Redistributing them unmodified is covered by MIT attribution: upstream's license is
  preserved verbatim at `LICENSE.upstream` and the arrangement is described in
  `NOTICE`.

**Directory paths are never renamed.** The forked packages keep their upstream paths —
`packages/coding-agent` and `packages/agent` — permanently. Only the npm names, the
binary, and the config directory become Apex Code's. Relocating `packages/coding-agent`
to `packages/apex-code` would move 634 files and make every future merge depend on
git's rename detection across an entire package, against an upstream measured at 57
changed files per patch release. It is the most expensive change available and buys
nothing a user can see: directory paths are internal, while the npm name and the
binary are the identity users actually touch. This follows from the general rule above
but is stated explicitly, because "tidy the paths to match the product name" is a
reasonable-sounding request that would quietly cost more than every other decision in
this ADR combined.

The prohibition is unchanged and now enforced: a change needed inside a consumed
package goes upstream as a contribution. A local patch converts a dependency into an
unmanaged fork without anyone deciding to, and now it also breaks the build.

## Amendment — 2026-08-26: the pin is a baseline plus backports

The prohibition is unchanged. What changes is how the gate expresses it.

`.upstream-tag` alone stated the rule as "byte-identical to a release", which conflates
two different things: **who authored the code**, which is the invariant this ADR is
about, and **upstream's release cadence**, which is an accident of how they ship. They
came apart on 2026-08-25.

models.dev stopped listing the `workers-ai/*` passthroughs under `cloudflare-ai-gateway`.
That catalog is generated at build time and `createProvider` inferred its type parameter
from it, so upstream's own frozen source stopped compiling and `main` went red on a
commit that changed nothing related. Upstream had already authored the fix — `e8c632ef6`,
which pins the type parameter and restores the passthroughs — but no tag carried it, and
`v0.84.2` and `v0.84.3` both still failed. This repository could not take a fix upstream
had already written, purely because of someone else's release schedule. The available
moves were to wait indefinitely, patch a frozen package, or work around it above the
boundary. The third shipped, and it duplicated upstream's generator logic in
`scripts/apex/`, which does not scale to the next occurrence.

So the pin is now a baseline tag **plus an ordered list of upstream commits taken ahead
of release**, listed in `.upstream-backports`. The frozen packages must equal the baseline
with each listed commit's own diff applied, restricted to frozen paths.

This is a stricter statement of the same rule, not a hole in it:

- Every byte still traces to a commit upstream wrote. A backport must be reachable from
  `upstream/main`, and its content is the diff read from upstream's history when the gate
  runs. Nothing hand-written is trusted, so a hand-edited patch cannot masquerade as an
  upstream fix the way a checked-in patch file could.
- The diff is applied, never the file's post-image. A backported file may have moved on
  upstream since the baseline — `generate-models.ts` had diverged by 149 lines — and
  taking its snapshot would import every unrelated change with it.
- Only frozen paths are carried. A backport is permission to take one fix across the
  boundary, not to import whatever else that commit touched.
- The gate now also catches a careless `.upstream-tag` bump, which the old check could
  not: a backport the new baseline already contains fails with an instruction to delete it.

A line earns its place only when upstream has already fixed something that breaks this
repository and no tag carries the fix. It is deleted at the next upstream merge, and the
gate enforces that rather than trusting anyone to remember.

**Ancestry cannot decide retirement here.** Upstream's release tags sit on a different
lineage from `upstream/main` — `v0.84.1` and `main` share only a merge-base from
2025-11-26, with roughly five thousand commits on each side since. A staleness test built
on `merge-base --is-ancestor` would silently never fire. Retirement is therefore decided
by content: a patch that will not apply forward but applies in reverse is already present,
which distinguishes a retired backport from a genuine conflict.
