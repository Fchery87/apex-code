# Spec: Complete the Apex Code product surface

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Active` |
| Created | 2026-08-16 |
| Last updated | 2026-08-16 |
| Roadmap phase | `10 — Complete the Apex Code product surface` |
| Tracking issue/PR | none |
| Compatibility posture | **Apex-first with bounded compatibility.** Current Apex-owned `PI_*` inputs and subprocess metadata gain canonical `APEX_CODE_*` names. Retained `PI_*` names remain temporary aliases, with Apex taking precedence, one deprecation diagnostic per process, and removal no earlier than the first stable major release. Consumed `pi-ai`/`pi-tui` identifiers, extension compatibility APIs, package-manifest vocabulary, historical attribution, and old module aliases are not renamed. Windows becomes a required portability CI job, not a supported sandbox platform. |

## Executive summary

The package coordinate, executable, primary state root, update lookup, and release
publication path already use Apex Code identity. The installed artifact does not. Its
npm README and bundled docs still describe Pi, recommend Pi's installer and executable,
contain false privacy/update claims, and use stale `.pi` paths. Live help, diagnostics,
trust prompts, system prompt, and external-editor output also identify the product as
Pi. Separately, the external-editor command is split on spaces, causing all three
carried tests to fail in this repository's real `Coding Projects` checkout and breaking
any quoted or spaced editor command in production.

Phase 10 completes the Apex-owned product surface without renaming upstream dependencies
or compatibility vocabulary. It centralizes environment-name compatibility, corrects
the shipped artifact and live strings, makes npm install/update the single coherent
distribution path, repairs documentation lifecycle drift, and converts the existing
advisory three-OS matrix into a required portability gate that executes from a checkout
whose absolute path contains a space.

This phase deliberately does **not** decide whether `pi.dev` remains the default model
catalog or `/share` viewer. It renames `PI_SHARE_VIEWER_URL` to the canonical
`APEX_CODE_SHARE_VIEWER_URL` interface; Phase 11 alone decides that interface's default.

## Context and motivation

- `docs/roadmap.md` settles the owned identity as package and binary `apex-code` and
  state root `~/.apex-code/`.
- ADR 0001 requires consumed `pi-ai` and `pi-tui` to remain dependencies and forbids
  editing them for this cleanup.
- ADR 0005 keeps Windows sandbox enforcement unsupported. Requiring the portable
  build/test surface on Windows does not amend that security boundary.
- Phase 9 correctly moved the update lookup to the npm `next` tag and removed the
  misdirected install ping, but explicitly carried the model catalog and share viewer.
- `AGENTS.md` requires completed plans to be deleted and durable results moved to specs;
  the completed Phase 4 plan remains and `contracts.md` contradicts ADR 0006.

## Current state

Verified against `12fccd034`.

| Fact | Evidence |
| --- | --- |
| The primary npm identity works | `packages/coding-agent/package.json` names `apex-code` and maps the `apex-code` binary to `dist/cli.js`; `npm view apex-code@next` reports that same bin. Release CI clean-installs the exact published version and runs `apex-code --version` on Ubuntu and macOS. |
| The primary state identity works | `config.ts` derives `APP_NAME = "apex-code"`, `.apex-code`, `APEX_CODE_CODING_AGENT_DIR`, and `APEX_CODE_CODING_AGENT_SESSION_DIR`; `getAgentDir()` defaults to `~/.apex-code/agent`. |
| The external-editor failure is real | `external-editor.ts:18` calls `command.split(" ")`. `npx vitest run test/external-editor.test.ts` from the real spaced checkout fails 3/3 with `Cannot find module '/home/nochaserz/Documents/Coding'`. |
| The npm front door is wrong | The packed CLI includes `packages/coding-agent/README.md`, `docs`, examples, and changelog. That README opens with Pi's logo/site, calls the product Pi, recommends `https://pi.dev/install.sh`, and tells users to run `pi`. Bundled quickstart/container docs repeat the wrong executable and paths. |
| Shipped network/privacy docs are false | Bundled README/settings/environment docs still describe the removed `pi.dev` update/install telemetry behavior, `enableInstallTelemetry`, and `PI_TELEMETRY`, while production now checks the npm `next` tag and sends no install ping. |
| Live identity is incomplete | Current help says “Update pi”; auth help prints `pi auth`; startup diagnostics recommend `pi -ne`; interactive/trust text says Pi; `system-prompt.ts` tells the model it operates inside Pi and sends it to Pi docs. |
| The owned environment inventory is smaller than the original claim | Apex-owned `packages/coding-agent/src` contains 15 literal `PI_*` names. Directory overrides are already canonical Apex names. Repo-wide counts include consumed package internals and test sentinels and are not this phase's edit scope. |
| Update discovery is already correct, but distribution has stale branches | `version-check.ts` queries `registry.npmjs.org/apex-code/next`; normal global self-update targets the Apex package. The compiled-binary fallback still points to upstream Pi releases, while tag CI publishes npm packages only. Generic publish/release scripts still describe Pi and can select frozen public workspaces. |
| Three-OS CI is not a real gate | `ci.yml` floats `checkout@v4`/`setup-node@v4` and marks macOS/Windows `continue-on-error`, citing nonexistent Task 0.10. Run 31929511021 was overall green while both advisory jobs failed first in the license-report workspace-symlink test. |
| Documentation lifecycle drift is present | `docs/plans/2026-08-13-tool-surface.md` is complete but tracked; its 2,706/2,150/2,300-token measurement is durable. `contracts.md` calls session schema settled in its table and open in §3 despite ADR 0006. |

## Problem

**P1 — Installing the Apex package presents and sometimes launches the wrong product.**
The npm README is a public package interface. Recommending Pi's installer and `pi`
command from `apex-code` can install or launch another product.

**P2 — The command-string interface loses argv.** Splitting on one ASCII space cannot
represent an executable or argument containing spaces and ignores quoting. The existing
three-test failure is a direct reproduction, not an inferred edge case.

**P3 — Environment identity is fragmented.** A few paths are Apex-named while controls
and child metadata remain Pi-only. A blanket rename would break scripts and extensions;
independent fallbacks would create inconsistent precedence and warning behavior.

**P4 — The release and documentation surfaces disagree with production.** Privacy,
network, state-path, changelog, container, binary-fallback, and generic-publish claims
cannot all be true simultaneously.

**P5 — CI reports success without enforcing its advertised portability.** Advisory jobs
mask known non-Linux failures, floating actions diverge from the SHA-pinned release
workflow, and the ordinary GitHub checkout path cannot exercise the path-with-space bug.

## Goals

- [ ] Parse existing string-valued editor configuration into a real executable plus
      argument vector, preserve exact arguments, and fail clearly on empty or malformed
      input without concatenating a shell command.
- [ ] Make `APEX_CODE_*` canonical for every Apex-owned legacy environment interface;
      preserve classified `PI_*` aliases temporarily with Apex precedence and a
      once-per-process deprecation diagnostic that never corrupts JSON/RPC stdout.
- [ ] Make every current live product/executable instruction say Apex Code / `apex-code`,
      while retaining reviewed upstream, compatibility, and historical Pi vocabulary.
- [ ] Make the actual packed npm README/docs accurate for install, launch, update,
      privacy/network behavior, and `.apex-code` paths.
- [ ] Make npm the one supported installation/update channel for this phase; no Apex
      command may direct users to an upstream Pi binary release or publish frozen
      upstream workspaces.
- [ ] Repair and enforce documentation lifecycle invariants, migrate Phase 4's durable
      measurement to its spec, delete its completed plan, and settle the session-schema
      contract text against ADR 0006.
- [ ] Require install/build/check/test on Ubuntu, macOS, and Windows portability
      surfaces from a checkout whose absolute path contains a space, with immutable
      action SHAs and no advisory matrix result.

## Canonical environment compatibility contract

The implementation owns one registry/projection for legacy environment names; callers
do not independently rederive aliases or warnings.

| Owned role | Current legacy names | Canonical form | Compatibility behavior |
| --- | --- | --- | --- |
| Runtime controls | `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_PACKAGE_DIR`, `PI_EXPERIMENTAL`, `PI_STARTUP_BENCHMARK`, `PI_TIMING`, `PI_CLEAR_ON_SHRINK`, `PI_HARDWARE_CURSOR`, `PI_SHARE_VIEWER_URL` | `APEX_CODE_OFFLINE`, `APEX_CODE_SKIP_VERSION_CHECK`, `APEX_CODE_PACKAGE_DIR`, `APEX_CODE_EXPERIMENTAL`, `APEX_CODE_STARTUP_BENCHMARK`, `APEX_CODE_TIMING`, `APEX_CODE_CLEAR_ON_SHRINK`, `APEX_CODE_HARDWARE_CURSOR`, `APEX_CODE_SHARE_VIEWER_URL` | Read canonical first, legacy second. Legacy-only use warns once per process. `PI_SHARE_VIEWER_URL` keeps the current default unchanged in this phase. |
| Process identity | `PI_CODING_AGENT` | `APEX_CODE_CODING_AGENT` | Apex entry points set canonical identity. Export the legacy alias during the compatibility window without warning for Apex's own internal write. |
| Bash/session metadata | `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` | `APEX_CODE_SESSION_ID`, `APEX_CODE_SESSION_FILE`, `APEX_CODE_PROVIDER`, `APEX_CODE_MODEL`, `APEX_CODE_REASONING_LEVEL` | Export canonical names and temporary legacy aliases so existing scripts continue to work. Canonical values are authoritative. |
| Already canonical directory inputs | none in production; old docs incorrectly name Pi forms | `APEX_CODE_CODING_AGENT_DIR`, `APEX_CODE_CODING_AGENT_SESSION_DIR` | No new Pi alias is invented. Correct docs to the existing production names. |

The authoritative implementation inventory, not this prose table alone, must fail tests
when a new Apex-owned `PI_*` literal appears unclassified. Consumed-package variables in
`packages/ai` and `packages/tui`, test-only sentinels, provider API-key variables, and
extension compatibility vocabulary are outside this registry.

Legacy input support is promised through the pre-1.0 line and removed no earlier than
Apex Code 1.0.0 and no earlier than 2027-02-16. The same version/date table is published
in the user environment guide. Legacy-only use writes one diagnostic to stderr in
interactive/text modes; canonical-plus-legacy writes one conflict diagnostic and the
canonical value wins. JSON/RPC modes expose diagnostics through their existing
structured diagnostic path and never add text to stdout. A future removal still
requires a release note and an intentional compatibility-test change, not silent
deletion.

## Product-identity classification

| Class | Examples | Disposition |
| --- | --- | --- |
| Current Apex product surface | banners, help, errors, trust dialogs, system prompt, current docs, temp/artifact prefixes | Use Apex Code / `apex-code` / `.apex-code`. |
| Consumed upstream identity | `@earendil-works/pi-ai`, `pi-tui`, upstream schema links needed by consumed formats | Retain; ADR 0001 boundary. |
| Compatibility vocabulary | extension callback convention `pi`, package manifest `pi` key, legacy module aliases, old theme symbol | Retain and explain where user-facing. |
| Historical/attribution material | LICENSE/NOTICE, clearly historical upstream changelog entries and issue links | Retain, clearly labeled. Add an Apex-versioned current changelog section rather than rewriting history. |
| Hosted-service endpoint | model catalog and `/share` viewer on `pi.dev` | Do not change defaults here; Phase 11/ADR 0013 decides them. |

## Proposed solution

### 1. External-editor command adapter

Keep existing string settings and `EDITOR`/`VISUAL` compatibility, but normalize once at
the external-editor seam to `{ executable, args }`. Support the documented quoting
subset consistently, reject empty/unclosed input with a user-visible failed result, and
spawn the executable directly. On Windows, do not combine user input and the temporary
file into a new shell string; native tests determine whether the existing `shell` flag
can be removed or must be narrowly retained. Rename the resume text and temp prefix.

### 2. Deep environment compatibility module

Add one small module whose interface resolves canonical/legacy inputs and constructs
canonical plus compatibility subprocess metadata. It owns precedence, internal-write
suppression, warning deduplication, and the inventory projection used by help/docs/tests.
Callers use this interface rather than touching classified legacy names directly.

### 3. Runtime and packed-artifact identity pass

Correct live strings and the model-facing system prompt. Rewrite the shipped package
README and current user docs as Apex surfaces, using the root user guide as verified
source material. Preserve upstream ecosystem documentation only where the compatibility
relationship matters. Add a packed-artifact truth test with a narrow reviewed allowlist,
not an indiscriminate global ban on the word Pi.

### 4. Distribution coherence

Retain npm `@next` as the supported prerelease channel. Correct self-update help and
fallbacks, current changelog headings/links, source-archive naming, and release messages.
Constrain generic publish machinery to the two Apex-owned packages or remove its public
entry point in favor of the already-tested tag workflow. Standalone binary build scripts
may remain developer tooling, but no shipped update instruction claims an unconnected
Apex binary release channel.

### 5. Documentation lifecycle validator

Move the Phase 4 measurement record into its permanent spec, delete the completed plan,
and change its roadmap Plan cell to `—`. Rewrite `contracts.md` §3 as settled under ADR
0006. Add a deterministic validator covering plan status/lifecycle, spec deletion
inventories, roadmap live-plan links, and contract summary/section status so the repair
cannot drift again.

### 6. Required spaced-checkout CI

Pin CI actions to the reviewed release-workflow SHAs. Run the existing three-OS matrix
from a checkout directory whose absolute path contains an ASCII space, assert that fact
before repository commands, and remove `continue-on-error` plus the Task 0.10 comment.
Repair every current platform blocker before making the jobs required, including the
license-report realpath/symlink test. Windows sandbox-specific tests continue to use the
established unsupported-backend predicates; portable build/test failures are required.
Add a workflow-structure test for immutable actions, required matrix semantics, and the
space assertion/working directory.

## Non-goals

- [ ] Renaming or patching consumed `pi-ai`, `pi-tui`, `pi-client`, `pi-protocol`, or
      `pi-telemetry` packages.
- [ ] Breaking extension APIs, Pi-manifest compatibility, historical sessions, old
      module aliases, or attribution history merely to reduce grep matches.
- [ ] Deciding or changing the default model-catalog or share-viewer endpoint. Phase 11
      owns both defaults. Phase 10 only changes the share-viewer variable interface.
- [ ] Declaring Windows sandbox enforcement or Windows product support. Required
      Windows portability CI does not amend ADR 0005.
- [ ] Creating an Apex installer service, hosted update API, model catalog, share viewer,
      binary release channel, or shell-completion feature.
- [ ] Bumping the JSONL session version or changing durable-state ownership.
- [ ] Removing all legacy `PI_*` aliases immediately.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `command.split(" ")` external-editor parsing | code | Replaced by validated argv normalization. |
| `pi-editor-*` and current Pi resume text | runtime artifact/string | Replaced with Apex identity. |
| Direct Apex-owned reads/writes of classified `PI_*` names | code | Replaced by the compatibility module; legacy strings remain only in its registry and explicit compatibility tests/docs. |
| Current Pi product/executable instructions in live runtime and shipped docs | code/docs | Replaced with Apex Code; reviewed upstream/history/compatibility references remain. |
| `pi.dev/install.sh` recommendation | shipped docs | Removed; Apex does not operate it and it installs another product. |
| Stale install-telemetry/update documentation | shipped docs | Removed or corrected to the npm version check and no project-directed telemetry. |
| Upstream standalone-binary fallback and `pi.dev` release-announcement claims | code/scripts | Removed; no connected Apex binary channel exists in this phase. |
| Generic publishing of frozen upstream workspaces | release script behavior | Removed or constrained to the two Apex-owned packages. |
| `docs/plans/2026-08-13-tool-surface.md` | completed plan | Durable measurement moves to its spec, then plan is deleted. |
| “Session entry schema — open” contract text | docs | Replaced by the settled ADR 0006 contract. |
| CI `continue-on-error` and Task 0.10 comment | workflow | Removed only after platform blockers are repaired. |
| Floating CI action tags | workflow | Replaced with reviewed full commit SHAs. |

## Verification

| Goal | How |
| --- | --- |
| Editor argv survives real paths | Failing-first public-boundary tests cover executable, script, capture, temp, and checkout paths with spaces; fixed args; quoted args containing spaces; quotes/backslashes; malformed/empty input; success/nonzero/empty editor outcomes. Native matrix execution, not mocked `process.platform`. |
| Environment compatibility is complete | Registry-derived table tests cover canonical-only, legacy-only, both-set precedence, unset behavior, once-per-process warning, internal writes, subprocess dual export, and machine-readable stdout cleanliness for every owned alias. Inventory test rejects new unclassified Apex-owned `PI_*`. |
| Packed product tells the truth | Build and `npm pack --dry-run --json`; package-surface test inspects included README/docs/current changelog and permits Pi only through a reviewed upstream/history/compatibility allowlist. Container/install/update examples execute or are structurally tested. |
| Distribution targets Apex only | Release/publish tests assert only `apex-code-agent-core` then `apex-code` are publishable by Apex paths; update tests assert npm `next`, Apex commands, and no upstream binary fallback. |
| Documentation lifecycle holds | New validator proves no completed plan remains, all live plans have status and valid roadmap links, every spec has a deletion inventory, Phase 4 measurement is permanent, and contract summary/section states agree. |
| CI is structurally required | Workflow test parses YAML: full-SHA actions, no matrix `continue-on-error`, all three OSes, repository commands run from a spaced checkout, and an executed cwd assertion exists. |
| CI is actually green | Required Ubuntu/macOS/Windows jobs pass install, build/typecheck/check and full root test suite from the spaced checkout. Record the real run URL and per-job conclusions before closure. |

Standard local gates after each slice: the narrow failing-first test, `npm run typecheck`
where available or `npx tsgo --noEmit`, `npm run build`, `npm run check`, then root
`npm test` at completion. CI-only platform claims remain unverified until the real
required jobs pass.

## Rollout

This work needs `docs/plans/2026-08-16-complete-apex-product-surface.md`. The editor and
current platform blockers should land first because they establish a truthful green
baseline. Environment compatibility precedes the broad docs/help rewrite so generated
names are available to those surfaces. CI becomes required only after all three jobs
pass without advisory semantics. The Phase 10 plan is deleted on completion after its
durable results move to this spec and the roadmap.

No ADR is required. The product identity was settled in Phase 0; this phase makes the
implementation conform. The temporary alias policy is a compatibility rollout with a
bounded removal rule, not a new permanent naming architecture. ADR 0013 belongs to
Phase 11 because hosted-service defaults remain genuinely contested.
