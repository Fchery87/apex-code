# Canonical authorization verifier

**Scope:** Read-only verification of CA.1--CA.5 against the current uncommitted
working tree. No source, staging, or commits were made. The prohibited
`c-code` tree was not accessed.

## Verdict: ISSUES

The focused authorization tests exercise useful cases and the gate is wired at
the `beforeToolCall` seam, but CA.1/CA.2 are not proved as claimed and the
current TypeScript check is red. The implementation also does not yet carry the
new operation model through the gate and execution. This is not a PASS for the
canonical authorization plan.

## Checks run

- `npx vitest run packages/coding-agent/test/permissions/canonical-authorization.test.ts packages/coding-agent/test/permissions/gate-universal.test.ts packages/coding-agent/test/permissions/contract.test.ts packages/coding-agent/test/permissions/lsp-rules.test.ts`
  - **PASS:** 7 files, 133 tests passed (the command also discovered matching
    tests under `.worktrees/prime-gold-tui`; those passed too).
- `npx tsgo --noEmit`
  - **FAIL:** `packages/coding-agent/test/permissions/canonical-authorization.test.ts(110,35): error TS2554: Expected 5 arguments, but got 4.`
    The test calls `definition.execute` with four arguments although the public
    execute boundary requires five. A green Vitest transform does not remove
    this typecheck failure.

## Findings

### 1. CA.1 operation variants are helper-only, not the canonical gate/execution model (ISSUE)

`packages/coding-agent/src/core/permissions/operations.ts` defines
`CanonicalPath`, `PathTarget`, `BashOperation`, `CommandOperation`,
`CredentialOperation`, and `EvidenceOperation`-shaped values, but the values are
not used by `evaluateToolCall`, the rule resolver, or tool execution. In
particular:

- `canonicalPathTarget()` has no production caller.
- `exactCommand()` has no production caller.
- `BashOperation`, `CommandOperation`, and `CredentialOperation` are not used at
  the permission boundary.
- `EvidenceOperation` is declared but is not part of `CanonicalOperation`.
- The actual path preparation uses a non-enumerable `Symbol` property carrying a
  string (`setCanonicalPath`/`getCanonicalPath`), not a validated discriminated
  operation value.
- `prepareCall` is optional and only path permission specs implement it. Bash,
  configured commands, credentials, and evidence do not carry a prepared
  operation.

Therefore the source supports a path-specific helper and a type declaration,
not the plan/spec claim that one canonical operation model supplies both
authorization and execution for all listed operation classes. This is the main
CA.1 issue and also weakens CA.2's architectural claim.

### 2. Canonical path execution has no no-follow/descriptor-relative protection against replacement (ISSUE)

The execution path does use the same prepared object: `agent-loop.ts` passes the
`validatedArgs` object to `beforeToolCall`, then passes that same object as
`prepared.args` to `executePreparedToolCall`. This resolves the parent concern
about cloned arguments; the production identity is real.

However, the prepared value is only a canonical pathname. `read`, `write`,
`edit`, `grep`, `find`, and `ls` subsequently perform ordinary pathname-based
operations. There is no no-follow open, directory-handle/descriptor-relative
operation, or equivalent final-component race defense. `resolveToCwd()` uses
`realpathSync` (or a canonical existing parent for a new target), but that is a
check-then-use boundary. Replacing the canonical final path with a symlink after
authorization can redirect a read or write. For new nested writes, a newly
introduced symlink in an originally missing path component can likewise redirect
traversal.

The new test named `executes the authorized target after a symlink is replaced`
only replaces the *alias* after authorization. Since execution has already
converted the alias to `/.../allowed.txt`, that test proves alias canonicalizing,
not resistance to replacement of the authorized pathname itself. It does not
prove the no-follow claim in CA.2 or the spec acceptance requirement.

### 3. CA.3 Bash behavior is conservatively improved, but the structured operation claim is unverified (ISSUE / helper-level only)

The current matcher does provide useful behavior: unparseable syntax cannot
match an allow; deny matching checks any segment; and a scoped deny can beat a
lower blanket allow. Grammar-sensitive quotes, backslashes, tabs, newlines, and
comments avoid whitespace collapsing for exact rules. The focused tests pass.

But this is still a string matcher over parser-produced `string` segments. It
does not produce or pass a typed `BashOperation`/structured operator tree into
the gate or executor. CA.3's behavioral subset is supported by focused helper
and resolver tests; the canonical operation-model portion remains unverified.

### 4. CA.4 production identity is proven, but the test is incomplete (PARTIAL)

The agent-core source confirms the exact flow: `prepareToolCallArguments` runs,
`validateToolArguments` produces `validatedArgs`, `beforeToolCall` receives it,
and `executePreparedToolCall` invokes the tool with `prepared.args`. Thus
`prepareCall` mutations made by the gate are visible to execution for the
production path.

The current test directly calls `evaluateToolCall` and then directly invokes
`definition.execute`; it does not itself drive the public agent loop. The
existing universal gate tests drive the loop for every ordinary built-in and
conditional LSP, but they do not assert that a prepared canonical target is the
one reaching the executor under a replacement race. CA.4 exact shell matching
is tested only at the spec helper boundary, not through a public approval then
execution flow with altered structure. Treat CA.4 as partial evidence, not a
fully verified acceptance claim.

### 5. CA.5 ordinary built-ins and LSP are covered; conditional MCP is not covered by the new registry test (ISSUE in evidence)

`AgentSession._installAgentToolHooks` calls `evaluateToolCall` from the single
`beforeToolCall` seam, and the agent loop executes only after that seam returns.
`getContract` resolves registered definitions and `resolveToolContract` falls
back to `UNCLASSIFIED`; the fallback defaults to `ask`, and no responder fails
closed. This supports the complete-mediation design for sessions where a
permission gate is configured.

The registry-driven tests cover the normal built-ins and a conditional LSP
registry. They do not instantiate/test the conditional `mcp` registry in this
CA test. Foreign-tool fallback is directly tested and passes. This leaves the
specific “every registered built-in plus conditional LSP and foreign fallback”
claim mostly supported, but the broader registered surface (including
conditional MCP) is not evidenced. Also, the gate remains optional in
`AgentSessionConfig`; no gate means no authorization, by design. Any claim of
unconditional mediation must say “when a permission gate is configured.”

## What is supported

- Rule resolution remains tool-owned; no second independent classifier was
  found. `rules.ts` delegates matching to each tool's `PermissionSpec`.
- The universal gate seam blocks before execution and the focused built-in/LSP
  tests observe no execution after denial.
- Unknown Bash grammar fails closed for allows and deny matching handles any
  prohibited segment.
- Foreign tools with no contract receive `UNCLASSIFIED` and fail closed without
  a responder.
- `@` aliases, symlink aliases, and literal glob characters are normalized or
  represented in the focused path tests.

## Required follow-up before PASS

1. Make the canonical operation values actual production inputs/outputs of the
   gate and execution (or narrow CA.1/CA.2 claims to the current path carrier).
   Remove helper-only operation declarations or add production callers and
   boundary tests for command, credential, and evidence variants.
2. Add no-follow/descriptor-relative execution (including new-write parent and
   intermediate-component handling), then add a public agent-loop race test for
   replacement of the authorized target, not only replacement of an alias.
3. Add public-boundary tests for exact approval reuse with altered quoted
   whitespace, newlines, comments, and escapes, and test conditional MCP
   registry mediation if MCP remains in the claimed registered surface.
4. Fix the `execute` call arity in `canonical-authorization.test.ts` and rerun
   `npx tsgo --noEmit`.



---

## Remediation response (implementer, 2026-09-05, uncommitted working tree)

This section records what was changed in response to the findings above, the
red/green evidence, and the claims that were deliberately narrowed. Nothing was
committed or staged.

### Changed files (CA scope only)

- `packages/coding-agent/src/core/permissions/operations.ts` — rewritten: the
  helper-only operation declarations are gone. The carrier is now a typed,
  validated value: `PreparedPathOperation` (`path-existing` with
  `FileIdentity {device, inode}` | `path-new`) stored in a WeakMap keyed by the
  execution input object (`setPreparedPathOperation` / `getPreparedPathOperation`).
  `canonicalPathTarget()` and `exactCommand()` were removed (they had no
  production caller). Command, credential, and evidence variants were **not**
  implemented — the CA.1 claim is narrowed to path operations (see limitations).
- `packages/coding-agent/src/core/tools/path-utils.ts` — `preparePathOperation()`
  captures dev/ino at authorization; `readPreparedPath()` and
  `writePreparedPath()` execute no-follow: intermediates are walked under a
  single directory fd (`O_DIRECTORY | O_NOFOLLOW`; on Linux each next open is
  `/proc/self/fd`-relative to the walked fd, so a swapped intermediate cannot be
  traversed), the final component is opened `O_NOFOLLOW`, and the descriptor
  identity is compared with the authorization-time identity before any byte is
  read or written. Existing writes truncate and write through the verified fd.
  New writes create missing parents no-follow under the walked fd and open
  `O_CREAT | O_EXCL | O_NOFOLLOW` mode 0600, so a pre-placed file or symlink at
  the target name aborts. Every mismatch throws `PreparedTargetChangedError`
  before execution touches the target.
- `path-permission.ts` — `prepareCall` stores the prepared operation on the
  execution input object; the agent loop already passes that same object to
  `executePreparedToolCall` (finding 2 confirmed this identity), so
  authorization and execution now share the validated operation value.
- `read.ts` — gated reads use `readPreparedPath`; the served bytes (text and
  image) come from the verified buffer, and MIME detection for gated reads uses
  `detectSupportedImageMimeType(buffer)` so no secondary unverified pathname
  open happens. Ungated calls keep the legacy ops seam.
- `write.ts` — gated writes use `writePreparedPath` inside the existing
  mutation queue; a gated call whose operations object lacks `writePrepared`
  fails closed (no pathname fallback for gated writes). Custom `operations`
  (SSH-style) callers without a gate keep the legacy path.
- `edit.ts` — gated edits read and write via `readPreparedFile` /
  `writePreparedFile` (same helpers); gate-time `access` is skipped because the
  prepared operation already proves existence, and the no-follow read enforces
  identity. Ungated calls unchanged.
- `grep.ts`, `find.ts`, `ls.ts` — use the gate-pinned canonical pathname
  (prepared operation) instead of re-resolving; no fd-pinned execution (see
  limitations).
- `test/permissions/canonical-authorization.test.ts` — all tests chdir-free;
  scratch dirs under `tmpdir()` removed in `afterEach` (repo state untouched).

### Red/green evidence

1. **Public agent-loop read race** (finding 2's "replacement of the authorized
   target"): `beforeToolCall` wraps the gate, authorizes `allowed.txt`, then
   swaps it to a symlink onto `denied.txt` before execution. Before the typed
   carrier existed the test failed:
   `AssertionError: expected false to be true` at
   `expect(result.isError).toBe(true)` — the read happily served the swapped
   target. After the carrier: the loop returns an error result and no
   "denied" content.
2. **Write/edit race suite mutation check**: with
   `getPreparedPathOperation` forced to return `undefined` (carrier disabled,
   everything else unchanged),
   `npx vitest run packages/coding-agent/test/permissions/canonical-authorization.test.ts`
   → **6 failed | 10 passed**: the agent-loop read race, all four write race
   tests (symlink swap of an existing target, impostor regular-file swap,
   missing-parent replaced by a symlink, target name pre-placed as a symlink),
   and the edit race test (same-content impostor and symlink alias) failed; the
   happy-path and non-race tests stayed green. Restoring the carrier:
   **Tests 16 passed (16)**.
3. **Gates** (final tree):
   - `npx vitest run packages/coding-agent/test/permissions/canonical-authorization.test.ts packages/coding-agent/test/permissions/gate-universal.test.ts packages/coding-agent/test/permissions/contract.test.ts packages/coding-agent/test/permissions/lsp-rules.test.ts packages/coding-agent/test/permissions/bash-grammar.test.ts packages/coding-agent/test/permissions/bash-command-segments.test.ts` → 10 files, **192 passed** (includes `.worktrees/prime-gold-tui` copies).
   - `npx vitest run` over `path-utils`, `edit-tool-legacy-input`,
     `edit-tool-no-full-redraw`, `file-mutation-queue`, `tools/edit-diagnostics`,
     `tools/contract-snapshot`, `tools.test.ts` → **266 passed**; one *file*
     failed to import: a stale copy under
     `.worktrees/upstream-provider-api-registry/` (extension bundle resolution,
     not a CA file; 266/266 tests in real trees passed).
   - `block-images`, `image-resize-callers`, `experimental-tool-strict-mode`,
     `evidence/file-mutation-capture`, `tool-system-prompt-contributions`,
     `mcp/mcp-tool.test.ts`, `mcp/contract.test.ts` → 14 files, **100 passed**.
   - `npx tsgo --noEmit` → exit 0 (the arity failure from finding 4 is gone:
     loop tests use `wrapToolDefinition`; direct execute calls pass five args).
   - `git diff --check` → clean.
4. **New public-boundary tests added** (findings 3/4/5):
   - Exact persisted bash approval through `evaluateToolCall` + persisting
     store: the approval matches only the identical command; altered quoted
     whitespace, an appended comment (unparseable → allow cannot match), and an
     appended newline (second segment) all fail closed to `block: true`.
   - Conditional MCP registry through the public agent loop: synthetic
     `McpServerConfig` with a `McpServerManager` whose connector throws if ever
     contacted. A scoped deny (`Mcp(metadata)`) blocks before execution; a
     scoped allow runs the cache-only search and returns
     `No cached MCP tool matches "synthetic"` with the connector never reached.
     Foreign-tool UNCLASSIFIED fallback remains covered by gate-universal.

### Narrowed claims and remaining limitations

1. **CA.2 is claimed for read, write, and edit only.** grep/find/ls pin the
   gate-authorized canonical pathname but do not execute fd-pinned; a swap of
   an *intermediate* directory between authorization and execution remains a
   theoretical window for those three tools. Blocker for full six-tool claims.
2. **Non-Linux fallback.** The walked-directory-fd chain needs
   `/proc/self/fd`. On platforms without it, the final-component `O_NOFOLLOW`
   open and the descriptor identity check still apply, but intermediates are
   opened by pathname prefix — an intermediate swap after the walk start is
   possible there. Verified behavior in this report is Linux-only.
3. **CA.1/CA.3 narrowed.** Only path operations carry a prepared operation
   through the gate. Bash keeps the grammar-sensitive string-segment matcher
   (unparseable fails closed; deny matches any segment); no typed
   `BashOperation` reaches the gate or executor. Command, credential, and
   evidence operation classes were **removed** rather than falsely claimed.
4. **CA.5 caveat unchanged:** the gate is optional in `AgentSessionConfig`;
   mediation claims hold only when a permission gate is configured.
5. Minor residuals: write/edit diagnostics and the mutation queue key on the
   canonical pathname (diagnostics only, no authorization effect); new files
   are created 0600 (deliberate hardening, a visible permission change).
