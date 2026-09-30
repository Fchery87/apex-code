# Self-update quality audit

**Status:** Active

## Scope and contract

Audit the uncommitted update-output change on `main` at `33dfa6da3` and its adjacent
self-update implementation. Preserve the update transcript, exit codes, install
commands, release activation, and managed and package-manager failure diagnostics.

## Design

Keep `SelfUpdatePlan` as the release decision and `SelfUpdateCommand` as the
package-manager operation. Keep managed and package-manager execution explicit in
the existing command handler. Share the successful completion message after both
branches. Keep Windows npm preparation before its installation progress message.

Remove the CLI update-note renderer. The npm registry parser produces only a
version and optional package name, so the CLI has no source of update notes.
Preserve the exported release type and the separate interactive notification API.

Keep output in the command handler, including the already-current message. The
release lookup helper returns its decision without printing.

## Verification

Vitest must resolve both root and subpath imports of `apex-code-agent-core` to
source. Its missing root alias currently selects stale compiled code with an
older transcript contract. The deferred-schema test fails identically with the
original CLI and the refactored CLI. Add the exact root alias already used by
`tsconfig.runtime.json`, then re-run the failing suites before the full suite.

The Anthropic schema tests also mix the source transcript normalizer with a
compiled API adapter. Map `pi-ai/api/*` to the existing workspace API source.
The concurrent-startup fixture must preload the existing source resolver, as
the other real CLI tests do, instead of falling through to compiled packages.
Remove its unused `TSX_TSCONFIG_PATH` setting. These are test infrastructure
repairs; provider implementations and production startup remain unchanged.

Characterize exact ordered output through `handlePackageCommand` for managed and
npm success and already-current releases. Check that rejected managed force,
unavailable installations, registry failures, and installer failures never print
success. Use scratch directories and fake installers that record their arguments.

Repair any reproduced fixture failure before restructuring production code. Run
the package-command tests, version-check and install-method tests, TypeScript,
repository checks, and the full test suite. Keep detailed logs under
`.apex-code/quality-audit/`.

## Deletion inventory

- CLI Markdown imports, update-note theme, and `printSelfUpdateNote`.
- Private `SelfUpdatePlan.note`, its propagation, and both unreachable render calls.
- Duplicate successful completion output and the managed success early return.
- Obsolete failure-test assertions against `Updated pi`.
- Vitest's accidental dependency on compiled agent artifacts for package-root imports.
- Mixed source and compiled provider imports and the startup fixture's unused tsx setting.

## Alternatives

A strategy object could unify progress and failure handling, but would carry
branch-specific state into a new abstraction. An extracted orchestrator would
move a single-caller workflow without removing its decisions. Retain the local
branches and their diagnostics. This limits the forked-file restructuring under
ADR 0003.
