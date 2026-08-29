# Spec: Dependency updates that can merge

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Status | `Active` |
| Created | `2026-08-29` |
| Last updated | `2026-08-29` |
| Roadmap phase | `none — release-integrity follow-up` |
| Tracking issue/PR | branch `fix/dependabot-workspaces` |
| Compatibility posture | Preserves compatibility. No product source, no published artifact, and no lockfile content changes. `.github/dependabot.yml` changes which directories Dependabot scans, which alters the shape of future bot pull requests and nothing a user installs. The seventeen open pull requests from the two removed ecosystems are superseded rather than repaired: they carry a lockfile edit this repository cannot accept, so Dependabot reopens them from the corrected configuration on its next run. That is a clean break in the bot's output, deliberately, because the alternative is hand-repairing seventeen branches that will be regenerated anyway. |

## Executive summary

Every open Dependabot pull request in this repository is red, and has been since they were
opened. Nine of nine fail, on all three operating systems, before a single test runs. The
cause is a configuration that treats an npm workspaces monorepo as three independent
projects, so a bump edits a workspace manifest and never the root lockfile the build
installs from. A test asserts that configuration, which is why it has stayed wrong.

## Context and motivation

- `.github/dependabot.yml` — the configuration under change. Its own comment states the
  scoping rationale that this spec shows does not hold.
- `scripts/apex/dependabot-config.test.mjs:15` — asserts the npm directories are exactly
  `["/", "/packages/agent", "/packages/coding-agent"]`. The test encodes the defect, so
  correcting the configuration requires correcting the test in the same change.
- `docs/adr/0001-fork-boundary.md` and `scripts/apex/frozen-packages.mjs:11` — the frozen
  package boundary the configuration is trying to protect.
- `scripts/generate-coding-agent-shrinkwrap.mjs` — generates
  `packages/coding-agent/npm-shrinkwrap.json` **from** the root `package-lock.json`. It is
  derived, not authored, which is why a bot hand-editing it produces a file no generator
  would emit.
- `docs/roadmap.md` Phase 12 — "production dependency vulnerability audit and SBOM
  generation are required release gates". Dependency hygiene is a stated release
  requirement here, and the automation feeding it currently lands nothing.

## Current state

Measured on 2026-08-29 against the last twenty CI runs.

- Nine consecutive Dependabot CI runs failed. No Dependabot pull request in the queue is
  green. The open queue is twenty-nine pull requests: seventeen from the two per-package npm
  ecosystems, nine from the root npm ecosystem, and three from `github-actions`.
- **Per-package ecosystems desynchronise the root lockfile.** Pull request #27
  (`bump ignore from 7.0.5 to 7.0.6 in /packages/coding-agent`) changes exactly
  `packages/coding-agent/package.json` and `packages/coding-agent/npm-shrinkwrap.json`. It
  does not change the root `package-lock.json`. CI runs `npm ci` from the root and fails on
  every OS with:

  ```
  npm error `npm ci` can only install packages when your package.json and
  package-lock.json or npm-shrinkwrap.json are in sync.
  npm error Missing: ignore@7.0.6 from lock file
  ```

  Reproduced locally on a clean clone by editing only that manifest: the error is
  byte-identical.

- **It also hand-edits a generated file.** That same pull request rewrites
  `npm-shrinkwrap.json` by `+2182/-233`. That file is produced by
  `scripts/generate-coding-agent-shrinkwrap.mjs` from the root lockfile, so a bot editing it
  directly is writing over a generator's output.

- **The root ecosystem edits frozen packages.** Pull request #11
  (`bump chalk from 5.6.2 to 6.0.0`, the `/` ecosystem) changes `package-lock.json`,
  `packages/coding-agent/package.json`, **and `packages/tui/package.json`**. `packages/tui`
  is frozen (`frozen-packages.mjs:13`), so the "Frozen packages match upstream" job fails by
  byte-identity, exactly as designed.

- `.github/dependabot.yml`'s comment says the configuration is "Scoped to the root
  (devDependencies and the shared lockfile) and the two Apex-owned packages only — never the
  six frozen, consumed Pi packages". Pull request #11 is a counter-example: directory scoping
  does not stop npm workspace resolution from rewriting a sibling workspace's manifest when
  they share a dependency.

None of this is forked Pi behaviour; the configuration is Apex's own.

## The problem

**1. No dependency update can land.** Not a slow queue — a total one. The blocked set
includes `undici` and `hosted-git-info`, both of which carry security fixes, in a repository
whose own release gates require a production vulnerability audit.

**2. The failure is pre-test, so the three-OS matrix is wasted on it.** `npm ci` fails at
install, so every Dependabot run burns three runners to report the same lockfile error
before compiling anything.

**3. A test holds the defect in place.** `dependabot-config.test.mjs:15` asserts the three
npm directories exactly. Anyone who corrects the configuration gets a red test and
reasonable grounds to conclude they are the one who is wrong.

**4. A comment claims a protection that does not exist.** The frozen-package scoping
described in `dependabot.yml` is disproved by pull request #11. The gate catches it, so
nothing unsafe merges — but the configuration keeps producing pull requests that can never
be green, and the comment tells a reader that cannot happen.

## Goals

- [ ] A dependency bump reaching a workspace package updates the root `package-lock.json`,
      asserted by the reproduction in § Current state no longer producing `EUSAGE`.
- [ ] `.github/dependabot.yml` declares exactly one npm ecosystem, at `/`, asserted by the
      updated configuration test.
- [ ] The configuration test asserts the workspaces-aware shape and states why, so the next
      reader who sees a per-package entry knows it is a regression rather than a choice.
- [ ] No frozen package directory is scanned, which the existing assertion already covers and
      which must keep passing.
- [ ] The comment in `dependabot.yml` describes what actually happens to a bump that touches
      a frozen manifest, rather than asserting it cannot occur.
- [ ] `CONTRIBUTING.md` states the one command a dependency bump needs after the lockfile
      syncs, so a maintainer can take a bot pull request to green without reverse-engineering
      it.

## Non-goals

- [ ] **A workflow that auto-commits regenerated artifacts onto Dependabot branches.** It is
      the obvious next step and it is deliberately not in this change. A bot that pushes to
      its own pull requests needs write permissions on `pull_request` events, which is the
      exact shape of a well-known privilege-escalation footgun, and it cannot be verified
      from a local checkout. It is recorded in Rollout as the follow-up, with the evidence
      this change produces.
- [ ] **Repairing the seventeen superseded pull requests by hand.** They carry a lockfile
      edit this repository cannot accept, and Dependabot closes them itself once the
      ecosystems that produced them are gone. Bulk-closing twenty-nine branches by hand
      risks closing the nine root-ecosystem ones that are still legitimate, which is the
      mistake this non-goal exists to prevent.
- [ ] **Changing which packages are frozen, or the byte-identity gate.** ADR 0001 owns that
      boundary. This change makes the bot stop producing pull requests that hit it by
      accident; it does not relax what happens when one does.
- [ ] **Pinning or grouping updates.** `groups` would cut the number of pull requests, which
      is a real improvement and a separate judgement about review load. Fixing "none of them
      can merge" comes first.
- [ ] **Touching `packages/agent`'s or `packages/coding-agent`'s declared dependencies.** The
      versions are not wrong. Only the mechanism that proposes new ones is.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Ecosystems | Replace the three npm entries with one at `/`, which npm workspaces already covers | `.github/dependabot.yml` |
| Comment | State what a frozen-manifest bump actually does: it fails the byte-identity gate and must be closed | `.github/dependabot.yml` |
| Config test | Assert one npm ecosystem at `/`, keep the frozen-directory assertion, and record why per-package entries are wrong | `scripts/apex/dependabot-config.test.mjs` |
| Contributor docs | The regeneration command a bump needs once the lockfile is synced | `CONTRIBUTING.md` |

No product source changes. No seam named in `docs/architecture/overview.md` is touched.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `/packages/agent` npm ecosystem entry | config | removed. The root ecosystem covers it through npm workspaces, and a per-package entry cannot update the lockfile the build installs from |
| `/packages/coding-agent` npm ecosystem entry | config | removed, same reason |
| `dependabot-config.test.mjs`'s three-directory assertion | code | superseded by a single-root assertion that records the reasoning |
| The claim that directory scoping keeps Dependabot out of frozen packages | doc | retired. Pull request #11 disproves it; replaced by a description of what the gate does when it happens |
| The seventeen open pull requests from `/packages/agent` and `/packages/coding-agent` | process | superseded, not repaired. Removing an ecosystem makes Dependabot close its pull requests on the next run and reopen equivalents from `/` |
| The nine open root-ecosystem pull requests | process | **not** superseded. `/` is kept, so they stay valid and stay red until the derived shrinkwrap is regenerated on the branch, or, where they touch a frozen manifest, until they are closed |

## Risks

**The root ecosystem still occasionally touches a frozen manifest.** It will, whenever a
frozen package and an owned package share a dependency, exactly as pull request #11 did. That
pull request fails the frozen gate and must be closed rather than merged. This change does not
prevent it and does not claim to; it stops the *other* eight failures and makes this one the
only remaining category. The signal is a Dependabot pull request whose only failing job is
"Frozen packages match upstream".

**Two derived artifacts go stale on every bump that reaches the published tree**, not one.
`npm-shrinkwrap.json` and `install-lock/package-lock.json` are both generated from the root
lockfile. `check:shrinkwrap` fails first and names its remedy, and running only that one
leaves `check:install-lock:coding-agent` failing immediately after -- confirmed on
Dependabot pull request #8, where regenerating the shrinkwrap alone moved the failure rather
than clearing it. Both commands are needed and `CONTRIBUTING.md` lists both. Until the
follow-up workflow exists this is a manual step, which is why it is documented rather than
left to be rediscovered.

**Consolidating hides which workspace requested a bump.** A single `/` ecosystem produces
titles without the `in /packages/coding-agent` suffix. The diff still names the manifest, so
nothing is lost that a reviewer needs.

## Verification

- `scripts/apex/dependabot-config.test.mjs` — the configuration shape, run by
  `npm run test:scripts`.
- The reproduction in § Current state, re-run on a clean clone: bumping a workspace manifest
  alone produces `EUSAGE`; syncing the root lockfile removes it.
- `npm run check` for the docs and lint gates.

The real proof is the next Dependabot run, which this change cannot execute. Rollout says what
to look for.

## Rollout

Small enough to implement directly; no separate plan document. Three files and their test.

**Follow-up, with the evidence this change produces.** Once a corrected Dependabot pull request
exists, the remaining manual step is `npm run shrinkwrap:coding-agent`. Automating it needs a
workflow that commits to a bot branch, which carries a real permissions decision and deserves
its own spec and ADR rather than being smuggled in here.

**What to check after the first weekly run.** A new Dependabot pull request should change
`package-lock.json` and the workspace manifest together, and should fail only on the derived
shrinkwrap, not on `npm ci`. If it still fails at install, the consolidation did not take and
this spec is wrong.
