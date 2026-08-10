# Plan: Phase 0 — fork foundation

> **For the implementing agent:** Read `AGENTS.md` first. ADR 0002 (no copying from
> unlicensed sources) applies to every task here. Work test-first where a task has a
> test; several infrastructure tasks legitimately do not, and say so.

**Status:** in progress — 0.1–0.5 verified; 0.6 next ·
**Date:** 2026-08-08 · **Spec:** `docs/specs/2026-08-08-fork-foundation.md`

**Goal:** A working fork of `pi-coding-agent` and `pi-agent-core` that builds, tests,
releases, takes upstream changes, and can measure itself against a replay corpus.

**Architecture:** Clone upstream with full history so merges stay ordinary `git merge`
operations. Rename to Apex Code with the minimum diff. Add CI, a release path, and a
deterministic offline replay runner that substitutes a recorded-response provider
through the existing registration API — no changes below the ADR 0001 line.

**Tech stack:** TypeScript, Node ≥ 22.19.0, `tsgo` (build), `vitest` (test),
`typebox` (schemas), GitHub Actions.

> **Execution order was changed during the phase.** 0.4 (CI) now runs before 0.3
> (rename). The table below is in *execution* order, and the reason is recorded in
> [Order changes](#order-changes) — read it before assuming the numbering is a
> sequence.

| # | Task | State | Commit(s) |
| --- | --- | --- | --- |
| 0.1 | Claim the name | **done** | `916bc83c2`, `ed07bf261` |
| 0.2 | Fork with history + merge rehearsal | **done** | `c81a7091a`, `cd8d84fe5`, `124f506e2` |
| 0.4 | CI + frozen-package assertion | **done** — Linux and macOS green; Windows characterised advisory | `fe0022498`, `9d5e7f0ad`, `990e1805d`, `707dd0440` |
| 0.3 | Rename to Apex Code | **done** — Linux/macOS green post-rename; Windows remains characterised advisory | `947e3f1ace`, `f6aa519afe` |
| 0.5 | Release pipeline | **done** — tagged publish, token-free OIDC, clean install, signatures, and provider turn verified | `6cff1fdd72`, `cf720a7d19`, `ef44c0148` |
| 0.6 | Session scrubber | not started | — |
| 0.7 | Corpus fixtures | not started | — |
| 0.8 | Replay runner | not started | — |
| 0.9 | Metrics + determinism gate | not started | — |
| 0.10 | Close the phase | not started | — |

Supporting commits not owned by a single task: `7576d67fc` (initial doc set),
`26dbfc35c` (history-rewrite record), `880a2e751` (`.gitignore` fix), `6bd29cb2c`
(directory-path correction).

> **SHA warning.** Commit hashes recorded before 2026-08-08's history rewrite are
> dead. Task 0.1 previously cited `4b04781`, which no longer exists — it became
> `916bc83c2`. If a hash in any Apex Code doc fails `git cat-file -t`, it predates the
> rewrite; find its replacement by commit subject, not by hash.

## Order changes

**0.4 (CI) was executed before 0.3 (rename).** This was not a convenience; the
original ordering was wrong.

Task 0.3 changes package identity across the monorepo — `package.json` names, the
`bin` entry, the config-directory constant, session path construction. It is the first
task that edits many files at once, and it is precisely the task most likely to touch
a **consumed** package by accident: a careless `grep`-and-replace over `packages/`
hits `ai`, `tui`, `client`, and `protocol` as readily as the two forked ones. That is
the ADR 0001 boundary violation the frozen-package gate exists to catch.

Running the rename first would mean the gate's first real exercise is a diff that
already contains the mistake, with no green baseline to compare against. Running CI
first means the rename lands with the boundary already enforced and a known-clean
starting point — the gate was verified passing on all 8 consumed packages at
`fe0022498`, so any drift 0.3 introduces is unambiguously 0.3's.

Two consequences worth carrying forward:

- The general rule this instance illustrates: **a task that establishes a guard should
  precede the first task capable of tripping it.** Task 0.5 (release pipeline) has the
  same relationship to publishing that 0.4 has to the rename.
- The plan's numbering is now non-sequential and stays that way. Renumbering would
  break the references in this document, in `docs/upstream-log.md`, and in commit
  messages already pushed. Numbers are identifiers, not an order — the same convention
  ADR 0010 adopted for ADR numbers.

---

## Task 0.1 — Claim the name ✅

No test. Registration work, first because the names thread through every later task.

**Outcome — 2026-08-08.**

| Surface | Value |
| --- | --- |
| Product name | Apex Code |
| Identifier / npm | `apex-code` — unscoped, verified free |
| Binary | `apex-code` |
| Config dir | `~/.apex-code/` |
| Repo | `github.com/Fchery87/apex-code` (public) |

Bare `apex` was checked first and rejected. The npm coordinate is held by an
abandoned 2022 stub (`v0.1.2`, description "Work In Progress", untouched since
2022-06-13). It declares no `bin`, so the *command* `apex` was actually free — but
taking it would have meant publishing under a scope while shipping an unscoped
binary, so users install one name and run another. `apex-code` is free on both, and
the install command matches the command you type.

**Still open:** the npm name is verified free but **not yet claimed**. Anyone can
take it until first publish. Claim it in Task 0.5.

**Repository:** initialized and pushed before this task formally ran; the initial
commit was reconciled rather than recreated.

History was rewritten once, on 2026-08-08, and force-pushed. The initial commit had
included `inline`, a stale status blob from an unrelated session carrying absolute
`/home/...` paths — exactly the pattern Task 0.7's corpus hygiene gate rejects. It is
gone from all reachable history; verified by scanning every blob in `main` for the
path prefix. Pre-rewrite history survives locally on `backup-pre-rewrite` and
`refs/original/refs/heads/main`, neither of which is pushed.

Note: commit `916bc83`'s message still says it dropped the artifact. After the
rewrite the artifact never existed in that history, so the message is a harmless
fossil — not worth a second rewrite to correct.

---

## Task 0.2 — Fork with history, and rehearse one upstream merge

No unit test. Verification is the recorded hunk count. **This task produces the
number ADR 0003's ceiling is derived from — do not skip the rehearsal to save time.**

**Files:** Create `docs/upstream-log.md`, `scripts/apex/upstream-merge.sh`.

**Step 1 — confirm the real upstream remote.** `package.json` declares
`github.com/earendil-works/pi`; published docs link to a `pi-mono` path. Resolve it
before cloning:

```bash
npm view @earendil-works/pi-coding-agent repository.url
git ls-remote https://github.com/earendil-works/pi.git HEAD
```

Expected: the second command prints a SHA. If it 404s, try the `pi-mono` URL and
record which one is real.

**Step 2 — clone with full history and add the upstream remote.**

```bash
git remote add upstream <resolved-url>
git fetch upstream --tags
```

**Step 3 — graft upstream history under Apex Code's root**, keeping `main` rooted in
upstream so future merges are ordinary merges. Pin the fork point to a **released
tag**, not to `HEAD` of the default branch — forking from an unreleased commit makes
the first merge's hunk count meaningless.

```bash
git tag --list | tail -5          # identify the latest release tag
git merge --allow-unrelated-histories <latest-release-tag>
```

**Step 4 — record the fork point.** Create `docs/upstream-log.md`:

```markdown
# Upstream log

Fork point and every subsequent merge. Hunk count is the metric ADR 0003 reads.

| Date | Upstream version | Conflicted hunks | Files touched (forked) | Time | Notes |
| --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | <tag> | — (fork point) | — | — | Initial fork |
```

**Step 5 — write the merge script.** It must print the hunk count, because a number
nobody is shown is a number nobody records.

```bash
#!/usr/bin/env bash
set -euo pipefail
git fetch upstream --tags
target="${1:?usage: upstream-merge.sh <upstream-tag>}"
git merge --no-commit --no-ff "$target" || true
hunks=$(git diff --diff-filter=U | grep -c '^@@' || true)
echo "conflicted hunks: $hunks"
echo "record this in docs/upstream-log.md before committing"
```

**Step 6 — rehearse a real merge.** Merge one upstream release *after* the fork
point. If the fork point is already the latest release, wait for the next one rather
than fabricating the rehearsal — and mark the phase blocked on it in the status
table. A synthetic rehearsal produces a synthetic baseline, which is worse than none.

**Step 7 — record it and commit.**

```bash
git add docs/upstream-log.md scripts/apex/upstream-merge.sh
git commit -m "chore: fork upstream at <tag>, add merge script and upstream log"
```

---

## Task 0.3 — Rename to Apex Code

> **Do not rename directories.** `packages/coding-agent` and `packages/agent` keep
> their upstream paths permanently. Change the npm names, the `bin` entry, the config
> directory, and session paths — nothing else. Relocating 634 files would make every
> future merge depend on rename detection against an upstream that moves 57 files per
> patch release. See the spec's non-goals and ADR 0001.

**Files:** Modify `packages/*/package.json`, binary name, config-directory constant,
session path construction.

**Name mapping:**

| Directory (unchanged) | npm name (changes) |
| --- | --- |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` → `apex-code` |
| `packages/agent` | `@earendil-works/pi-agent-core` → `apex-code-agent-core` |

Consumed packages (`ai`, `tui`, `client`, `protocol`) keep their upstream names and
are resolved from npm in published artifacts. They are frozen — the CI assertion from
Task 0.4 fails the build if they differ from the upstream tag.

**Step 1 — find every identity surface** before changing any of it:

```bash
grep -rn '"\.pi"\|~/\.pi\|piConfig\|\bpi\b' --include='*.json' --include='*.ts' packages/ | grep -v node_modules | head -40
```

**Step 2 — write the failing test.** The rename has one externally checkable
property: state goes to `~/.apex-code/`, not `~/.pi/`.

```ts
// packages/coding-agent/src/core/__tests__/config-dir.test.ts
import { describe, expect, it } from "vitest";
import { resolveConfigDir } from "../config-dir.js";

describe("resolveConfigDir", () => {
  it("resolves under .apex-code, never .pi", () => {
    const dir = resolveConfigDir("/home/u");
    expect(dir).toBe("/home/u/.apex-code/agent");
    expect(dir).not.toContain(".pi");
  });
});
```

**Step 3 — run it and confirm it fails** for the right reason (module not found, or
a `.pi` path), not a typo:

```bash
npx vitest run packages/coding-agent/src/core/__tests__/config-dir.test.ts
```

**Step 4 — apply the rename.** Package names, `bin` entry, config-directory constant,
session path construction. **Nothing else** — no reformatting, no restructuring, no
import reordering. Every cosmetic edit here is permanent merge cost (ADR 0001).

**Step 5 — verify.**

```bash
npx vitest run packages/coding-agent/src/core/__tests__/config-dir.test.ts   # PASS
npm run typecheck
grep -rn '~/\.pi' packages/ --include='*.ts' | grep -v node_modules  # expect: no output
```

**Step 6 — record the rename's own hunk count** in `docs/upstream-log.md` as a
separate row, so Task 0.2's baseline is not confounded by it.

**Step 7 — commit.**

```bash
git commit -am "refactor: rename forked packages to apex-code, config dir to ~/.apex-code"
```

**Verified 2026-08-09.** CI run
[`31300453521`](https://github.com/Fchery87/apex-code/actions/runs/31300453521)
passed the frozen-package gate and completed green after the rename. Linux and macOS
passed Build, Check, and the Apex-owned test suites. Windows retained the same advisory
inherited failures recorded by Task 0.4; Task 0.3 introduced no new required-leg
failure.

---

## Task 0.4 — CI

**Current verification — 2026-08-09.** The workflow has run four times, and all four
runs were red. The frozen-package assertion and builds passed; the first four runs
failed in `npm run check` because `package-lock.json` still referenced the deleted
`evals` and `session-backends` workspaces. Run 5 confirmed that repair: Build and Check
passed on all three platforms, then Test exposed two separate issues. The root test
command still ran frozen-package suites, including an upstream `pi-ai` failure we may
not repair, and Windows exposed inherited platform failures in forked-package tests.
Task 0.4 remains in progress until Linux's owned-package test leg is green. macOS and
Windows remain advisory until
Task 0.10 characterises their inherited baseline, per the amended roadmap criterion.

**Verified 2026-08-09.** Run
[`31298112668`](https://github.com/Fchery87/apex-code/actions/runs/31298112668)
passed the frozen-package gate and completed successfully. Linux and macOS passed
Build, Check, and the Apex-owned test suites. Windows passed Build and Check but its
advisory Test step failed on inherited platform behavior; the job's advisory status
kept the workflow green. This is the pre-rename baseline Task 0.3 requires.

**Files:** Create `.github/workflows/ci.yml`.

Matrix over Linux, macOS, Windows on Node 22. Steps: install, `typecheck`, `lint`,
`test`, `build`. Windows is in the matrix from day one — upstream supports it, and
path handling is where a fork breaks it silently.

**Verify:** push a branch, confirm all three legs go green. A workflow that has never
run is not done.

**Commit:** `ci: typecheck, lint, test, build on linux/macos/windows`

---

## Task 0.5 — Release pipeline

**Files:** Create `.github/workflows/release.yml`.

Tag-triggered. Builds, then publishes the artifact. Publish a `0.0.1-alpha.0` to
prove the path end-to-end — a release path first exercised at Phase 9 is a release
path that does not work.

**Verify:** install the published artifact on a clean machine or container, run
`apex-code --version`, and complete one turn against a configured provider.

**Verified 2026-08-09.** Tag `v0.0.1-alpha.0` triggered
[release run `31326901954`](https://github.com/Fchery87/apex-code/actions/runs/31326901954),
which built, checked, tested, published `apex-code-agent-core` before `apex-code`, and
clean-installed the CLI from npm. An independent scratch install reported
`0.0.1-alpha.0`; `npm audit signatures` verified 144 registry signatures and 32
attestations; and the installed artifact completed a Google provider turn with the
expected response `apex-release-ok`. Both npm packages expose SLSA provenance.

Trusted Publishing was subsequently proven without `NPM_TOKEN` by attempt 3 of
[release run `31349371366`](https://github.com/Fchery87/apex-code/actions/runs/31349371366):
both `0.0.1-alpha.1` packages published through GitHub OIDC with signed provenance.
The run's final clean-install step exhausted its original five-minute retry window
against a stale registry edge, but an independent fresh-cache install succeeded,
reported `0.0.1-alpha.1`, and passed `npm audit signatures` with 144 verified registry
signatures and 32 verified attestations. The verifier now discards negative npm-cache
state between attempts and allows ten minutes (`ecf339da7d`). Main CI run
[`31355755436`](https://github.com/Fchery87/apex-code/actions/runs/31355755436) then passed
the frozen boundary and Linux/macOS gates; Windows retained only its characterised
advisory failure. Bootstrap-credential revocation and the
package-level disallow-token setting remain human account-hardening steps; no token is
stored in the workflow or GitHub `npm` environment.

**Commit:** `ci: tag-triggered release pipeline`

---

## Task 0.6 — Session scrubber

Corpus fixtures come from real transcripts containing live credentials and personal
paths. Scrubbing is enforced by test, never by review.

**Files:** Create `scripts/scrub-session.ts`, `scripts/__tests__/scrub-session.test.ts`.

**Step 1 — write the failing tests.** Include a *negative* case: the scrubber must
reject something, or it is unproven.

```ts
import { describe, expect, it } from "vitest";
import { scrub, findSecrets } from "../scrub-session.js";

describe("scrub", () => {
  it("redacts api-key-shaped strings", () => {
    const line = JSON.stringify({ apiKey: "tcb_ds_v1.AbC123_xyz-QQ" });
    expect(scrub(line)).not.toContain("AbC123");
    expect(scrub(line)).toContain("[REDACTED]");
  });

  it("replaces absolute home paths with a placeholder", () => {
    expect(scrub("/home/alice/Projects/x")).toBe("$HOME/Projects/x");
  });

  it("preserves message structure", () => {
    const line = JSON.stringify({ type: "message", id: "a1", parentId: null });
    expect(JSON.parse(scrub(line))).toMatchObject({ type: "message", id: "a1" });
  });

  it("findSecrets detects what scrub would have missed", () => {
    expect(findSecrets('{"key":"sk-live_0123456789abcdef"}')).toHaveLength(1);
    expect(findSecrets('{"text":"hello"}')).toHaveLength(0);
  });
});
```

**Step 2 — run, confirm failure.**

```bash
npx vitest run scripts/__tests__/scrub-session.test.ts
```

**Step 3 — implement** `scrub()` and `findSecrets()`. Patterns: provider key prefixes,
long high-entropy tokens, `/home/<user>` and `/Users/<user>`, hostnames, email
addresses. Preserve JSON structure and the `id`/`parentId` tree — a scrubber that
breaks the tree destroys the corpus.

**Step 4 — verify PASS. Step 5 — commit.**

```bash
git commit -m "feat: session scrubber with secret detection"
```

---

## Task 0.7 — Corpus fixtures

**Files:** Create `fixtures/corpus/*.jsonl`, `fixtures/corpus/README.md`,
`fixtures/__tests__/corpus-hygiene.test.ts`.

**Step 1 — write the hygiene gate first**, before any fixture exists:

```ts
it("no fixture contains a secret or absolute personal path", async () => {
  for (const file of await corpusFiles()) {
    const text = await readFile(file, "utf8");
    expect(findSecrets(text), `secret in ${file}`).toHaveLength(0);
    expect(text).not.toMatch(/\/(home|Users)\/(?!\$)/);
  }
});
```

**Step 2 — select sessions.** Aim for 8–12 covering: a short single-turn session, a
long multi-turn session that triggered compaction, a session with heavy tool output
(the eviction case Phase 3 measures), a session with a model switch mid-run, and one
with an error and recovery. **Prefer throwaway projects** — these are real transcripts
of real work, and scrubbing handles credentials, not sensitivity.

**Step 3 — scrub, then verify the gate passes. Step 4 — prove the gate bites:**
temporarily add a fixture containing a fake key, confirm the test fails, remove it.
Note in the PR that you did this.

**Step 5 — commit.**

```bash
git commit -m "test: scrubbed replay corpus with enforced hygiene gate"
```

---

## Task 0.8 — Replay runner

**Files:** Create `packages/coding-agent/src/testing/replay/{runner.ts,recorded-provider.ts}`
and tests.

**Step 1 — write the failing test.**

```ts
it("replays a session offline and emits metrics", async () => {
  const result = await replay("fixtures/corpus/short-session.jsonl");
  expect(result.turns).toBeGreaterThan(0);
  expect(result.metrics.contextTokensByTurn).toHaveLength(result.turns);
  expect(result.networkCalls).toBe(0);   // the whole point
});
```

**Step 2 — run, confirm failure. Step 3 — implement.** Register a recorded-response
provider through the **existing** provider registration API and replay assistant
responses from the transcript. Do not modify `pi-ai` — if this appears to require it,
stop: that is an ADR 0001 boundary question, not an implementation detail.

**Step 4 — verify PASS. Step 5 — commit.**

```bash
git commit -m "feat: offline deterministic replay runner"
```

---

## Task 0.9 — Metrics and the determinism gate

This task produces the instrument every later phase gate reads. **It is the reason
Phase 0 exists.**

**Files:** Create `packages/coding-agent/src/testing/replay/metrics.ts` and tests.

**Step 1 — write the determinism test first.**

```ts
it("produces identical metrics across two consecutive runs", async () => {
  const a = await replayCorpus("fixtures/corpus");
  const b = await replayCorpus("fixtures/corpus");
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});
```

**Step 2 — run, confirm failure. Step 3 — implement the metrics schema:**

| Metric | Why it exists |
| --- | --- |
| `contextTokensByTurn` | Phase 3's primary gate |
| `systemPromptTokens` | Deferred-schema saving (Phase 3/4) |
| `cacheHitRate` | Eviction can invalidate cached prefixes and cost more than it saves — see research Finding 4 |
| `toolCallsByName` | Phase 4/5 behavior change detection |
| `wallTimeMs`, `costUsd` | Phase 8 |
| `turnsCompleted` | The no-regression clause on every gate |

**Step 4 — make it deterministic.** Exclude or pin wall-clock and ordering-dependent
fields explicitly, and **write a comment saying why for each one**. Loosening the
equality check instead is how this gate quietly stops working.

**Step 5 — verify PASS twice in a row. Step 6 — commit.**

```bash
git commit -m "feat: replay metrics schema with determinism gate"
```

---

## Task 0.10 — Close the phase

**Step 1 — amend ADR 0003** with the concrete ceiling: 3× the Task 0.2 baseline.
Change its status line from "ceiling value pending Phase 0 baseline" to "Accepted".

**Step 2 — record the Phase 3 baseline.** Run the corpus and write the current median
context tokens at turn 20 into `docs/roadmap.md` Phase 3, replacing
*(baseline from Phase 0)* with the real number. Phase 3's gate is meaningless until
this exists.

**Step 3 — verify every Phase 0 exit criterion** in `docs/roadmap.md`, pasting real
command output for each. Do not tick one you did not run.

**Step 4 — update the roadmap status table** to `landed` with the commit.

**Step 5 — write the Phase 1 spec** (`docs/specs/<date>-provider-and-model-layer.md`)
using `docs/specs/TEMPLATE.md`.

**Step 6 — delete this plan.** Per `AGENTS.md`, completed plans are deleted, not
archived. Git retains it.

```bash
git rm docs/plans/2026-08-08-fork-foundation.md
git commit -m "docs: close phase 0, amend ADR 0003 with merge ceiling"
```
