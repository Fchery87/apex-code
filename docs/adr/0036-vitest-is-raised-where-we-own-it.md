# ADR 0036 — vitest is raised in the forked workspaces; the frozen five wait for upstream

**Status:** Accepted · **Date:** 2026-09-20

`packages/agent` and `packages/coding-agent` declare `vitest@5.0.0`. The five frozen
workspaces keep whatever version upstream pinned, and their copies stay vulnerable until
upstream re-pins. A root `overrides` entry was tried first and rejected; the reason is worth
recording, because it is not obvious and it will be tried again otherwise.

## Decision

GHSA-82fw-gwwq-j7x9 (moderate) is a path traversal in `@vitest/mocker`: a redirect mock's
target is registered without validating it against the dev server's file-serving allowlist, so
a client that can reach the dev server's WebSocket can read files outside the project root. It
is patched in 4.1.11 and absent from 5.x. Nine Dependabot alerts were open against this single
advisory, and `vitest@4.1.9` was genuinely installed seven times over — one nested copy per
workspace, not merely a lockfile entry.

Dependabot cannot fix it. Five of the seven workspaces declaring the vulnerable range are
frozen under ADR 0001 — `packages/ai`, `packages/client`, `packages/protocol`,
`packages/server`, `packages/telemetry` — and their manifests are held byte-identical to the
pinned upstream tag by `scripts/apex/check-frozen-packages.mjs`. Editing them to raise the
version fails that gate, which is the gate's purpose. #121 targeted `packages/client` and was
unmergeable by construction rather than by peer conflict, which is also why Dependabot's own
updater jobs kept failing on this advisory.

So we raise it in the two workspaces we fork and own, and leave the five we do not.

## Why not a root `overrides` entry

`overrides` is the mechanism this repo already uses for `protobufjs` and `rimraf`, and it
looks like the obvious answer: it would collapse all seven copies without writing inside a
frozen directory. It was implemented, and it worked — on the wrong npm.

CI runs **node 22**, which ships **npm 10.9.8**. That is deliberate: `engines` declares
`>=22.19.0`, and testing the supported floor is the point. Local development and the release
workflow run node 24 with npm 11.

Under npm 11 the override collapses all seven copies to one hoisted 5.0.0 and `npm audit`
reports zero vulnerabilities. Under npm 10.9.8 the same `package.json` leaves every nested
4.1.9 copy in place: npm 10 does not apply a root override to a workspace's own *direct*
dependency. Verified by a full clean install on each, not by reading the docs.

Worse, the lockfile npm 11 produces with that override is one npm 10 cannot consume at all —
`npm ci` dies with `Cannot read properties of null (reading 'edgesOut')`, which is how CI
found this. The same lockfile without the override installs cleanly on both. So the override
was not merely a no-op on the version CI tests; it broke it.

Raising `engines` or moving CI to node 24 would make the override work, and both are the wrong
trade for a dev-only advisory: the first is a breaking change for users, the second stops
testing the floor we claim to support.

## The pin this produced

The divergence was only visible because CI failed. Nothing in the repository declared which
npm was correct, so a lockfile generated on npm 11 looked entirely healthy locally — full
suite green — and broke every CI job on install.

`package.json` now carries `"packageManager": "npm@10.9.8"`, the npm that Node 22 bundles and
that CI therefore runs. corepack honors the field where it is enabled; npm does not enforce it
on its own, so `scripts/check-lockfile-commit.mjs` checks it whenever a lockfile is staged and
refuses the commit on a major mismatch, naming the `edgesOut` failure it prevents.

That check runs *before* `PI_ALLOW_LOCKFILE_CHANGE`, because that flag asserts the package
changes were reviewed, which is a different claim from having used an npm whose lockfile CI can
install. It compares only the major — a patch difference is not a compatibility hazard, and
failing on one would make the guard noise — and an npm it cannot detect is not treated as a
mismatch, since the guard exists to catch a known-bad combination rather than to demand proof
of a good one. `PI_ALLOW_NPM_VERSION_MISMATCH=1` overrides it.

`scripts/npm-pin.test.mjs` ties the pin to CI: it fails if the two disagree, and if CI moves to
a Node major whose bundled npm is not recorded, so raising the Node version forces the pin to
be revisited in the same change.

## Consequences

Five frozen packages still install `vitest@4.1.9`. The exposure is small and worth stating
precisely rather than waving at. `vitest` is a devDependency, so it reaches no published
consumer. This repo's `test` script runs only `packages/agent` and `packages/coding-agent`, so
no frozen package's suite is ever invoked here. The advisory requires a reachable vitest dev
server, which nothing in this repo starts. What remains is a vulnerable package present on
developer and CI machines, which is real but not reachable through anything we run.

Those five Dependabot alerts cannot be closed by a code change available to us. They clear when
the frozen packages are next re-pinned to an upstream tag carrying a patched vitest — the same
event that clears any frozen-package advisory. Until then they should be left open rather than
dismissed, because an open alert is an accurate description of the state.

The upgrade surfaced one real defect in the code we do own. `packages/agent`'s
`test/harness/session/jsonl-storage.test.ts` asserted on a promise without awaiting it, so the
assertion had never actually run. vitest 5 fails on an un-awaited `expect(...).resolves`, which
is why the bump found it. Awaited, the assertion passes.
