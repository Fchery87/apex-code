# Architecture critique — sandbox, trust, permission, and policy-command boundaries

**Status:** read-only architectural critique of the 2026-09-03 audit. Reviewed against
application source at `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00` (application packages
byte-identical at HEAD `1964612833cddbf89e4ad61fa0921e8b42f488cc`; the only diff is a CI
hydration script). Method note: this is the "explain, then critique" shape from the `how`
skill's Critique mode, produced as a single-critic lead judgment. I did not fan out
multiple critic models; the read-only contract and urgency made that pointless for a
synthesis over work the sibling reviews already covered at finding granularity
(`permissions-review.md`, `sandbox-review.md`, `execution-release-review.md` in this
directory). I did not access the prohibited `c-code` tree, did not edit source, and ran no
new live turns.

**Headline.** The audit's central claim is right and is an architectural claim, not a
catalog: *the three boundaries — trust, authorization, OS containment — are separate, and
independent paths bypass each.* What it understates is that two of the four "is this an
escape?" questions have defensible answers (SDK = embedding contract; `declaredPaths` =
enforcement-intended-but-observation-implemented), and two of its High ratings overstate
reachability (`ask`-ignored, formatter path). The most valuable repairs are wiring fixes at
existing seams, not new subsystems and not a second capability classifier.

---

## 1. The architecture, explained

Three independent controls, one public entry.

1. **Project trust** decides whether repository-owned configuration may load.
   `hasTrustRequiringProjectResources` (`core/trust-manager.ts:185-193`) detects
   `.apex-code/{settings.json,extensions,skills,prompts,themes,SYSTEM.md,APPEND_SYSTEM.md}`
   and `.agents/skills` (`:30-38`). `main()` resolves `projectTrusted` and passes it into
   `SettingsManager` (`main.ts:770-777`).

2. **Authorization** decides whether a proposed tool call runs. `FilePermissionRuleStore`
   reads policy/local/project/user files (`core/permissions/store.ts:160-170,198-231`) and
   `evaluateToolCall` → `resolvePermission` picks a matching rule
   (`core/permissions/rules.ts:76-100`). Precedence is `policy > flag > local > project >
   user > cliArg > command > session` (`rules.ts:16-25`).

3. **OS containment** confines the resulting process tree. The public CLI (`cli.ts`) either
   launches a supervised sandbox child (`cli.ts:54-107`) or falls through to `main()` on the
   host (`cli.ts:110-116`). The Linux backend builds a Bubblewrap child; the workspace is the
   writable root, `/home` is a tmpfs, and the supervisor owns network, credential,
   escalation, and terminal channels as host-side services (`core/sandbox/linux-backend.ts`,
   `core/sandbox/terminal-handoff.ts`, `core/sandbox/rpc/`).

ADR 0005 makes the shape explicit: the boundary is "the Linux Apex child-process tree,"
the whole-CLI launch shape is "mandatory," and the child gets "private temporary/state
paths" while host-home and normal credential/session directories are denied. ADR 0016
requires supervisor policy (mounts, allowlists, argv) to come only from the runtime
environment and explicit user/maintainer inputs — never project files — before trust.
ADR 0023 requires the supervisor (not the child) to read escalation/credential decisions.
ADR 0028 says policy commands are "exec" (verification) or "exec plus fs.write confined to
its declared paths" (formatter), and that "nothing runs unless a policy is configured and
its permission class admits the run."

The defects are all places where one of those three statements is not implemented at its
seam.

---

## 2. The four questions

### 2.1 Is `declaredPaths` intended enforcement or observation?

**Enforcement. The implementation is observation.**

The intent is unambiguous:

- ADR 0028: "a formatter is `exec` plus `fs.write` **confined to its declared paths**."
- Spec `docs/specs/2026-09-01-configured-verification-and-formatting.md` line 123: the
  formatter "must refuse path traversal, symlink escapes, and **writes to undeclared
  files**"; Risks: "Before/after path checks and declared scopes must **detect and reject**
  this"; Verification table: "**denied policies execute nothing**."

The implementation only observes. `runFormatterCommand`
(`core/formatter-lifecycle.ts:195-274`) snapshots the workspace before/after
(`:229,235`), diffs (`:237`), and classifies each change as `undeclaredPaths` or
`escapedPaths` (`:238-249`) — but it never refuses an undeclared or escaped write and never
restricts what the command may touch. The command itself runs via `runPolicyCommand`
(`:230`), which spawns `executable argv` with `shell:false` and no path confinement
(`core/policy-executor.ts:174-180`). The only refusal in the formatter path is lexical
`..`/absolute-pattern rejection (`formatter-lifecycle.ts:205-221`), not mutation
containment. The header comment even states the posture: "Nothing is reverted — the
workspace belongs to the user; the report is the evidence" (`:8-9`).

The audit's claim #4 is therefore **correct**, and this is a spec-vs-implementation
divergence, not a naming debate. The sibling corrected probe reproduced it at the public
`AgentSession.runConfiguredFormatter()` boundary: `formatterStatus= passed`,
`undeclaredPaths=[ 'unrelated.txt' ]`, `undeclaredWritePersisted= true`. A formatter that
writes outside its declared scope returns `passed`.

### 2.2 What does "ignored permission" imply when a human explicitly chose the command?

`permission` is parsed (`core/policy-loader.ts:165-168`, defaulting to `"ask"`) but never
consulted by the executor (`core/policy-executor.ts:125-285` never reads
`command.permission`). Both `VerificationTracker.runExplicit`
(`verification-lifecycle.ts:122`) and `runFormatterCommand`
(`formatter-lifecycle.ts:230`) call `runPolicyCommand` directly. The corrected probe showed
a `permission:"deny"` verification returning `verified` with `gateCalls=0` — the tool
permission gate is not merely bypassed, it is never entered.

But "the human chose the command" changes the severity per value, and the audit collapses
them into one High:

- **`deny` ignored = High, and the human-choice argument does not excuse it.** A human who
  writes `deny` is stating the strongest available intent — "this must not run" — and the
  one behavior that must never be silently dropped is the denial. ADR 0028 ("nothing runs
  unless its permission class admits the run") and the spec's "denied policies execute
  nothing" make it a fail-closed contract, and the implementation fails open. Configuring a
  command is not consent to override a `deny` on it.
- **`ask` ignored = Medium, and here the human-choice argument does mitigate.** The human
  explicitly configured the command, and for project scope the project was already trusted
  (`policy-loader.ts:262-265` drops project policies when untrusted — policies are, unlike
  MCP, trust-gated). What is lost is the per-run interactive confirmation the spec promised
  (§1 "ask", §3 "an interactive approval step"), not authorization of a repo-chosen command.
  ADR 0004 already says `ask` with no responder must fail closed; it currently runs. That is
  a real contract gap, but a smaller one than `deny`.
- **`allow` ignored = harmless** — it is the execution path's default.

The audit's finding #4 headline ("deny executes") is right; its flattening of `ask` into
the same High overstates the practical delta for the human-configured case. Recommended
wording for the final report: `deny` = High fail-closed defect; `ask` = Medium
missing-prompt defect with a human-choice mitigant.

### 2.3 Is the SDK's absence of an OS sandbox an embedding contract rather than an escape?

**Embedding contract — but currently undocumented, and the real escape is elsewhere.**

The OS boundary is a property of the CLI supervisor, not of the library. ADR 0005 scopes
it as "the Linux Apex child-process tree" and mandates "this whole-CLI launch shape."
`cli.ts:54-107` is where the boundary is erected; `core/sdk.ts` `createAgentSession` (a
public export, `index.ts:215-243`) constructs a session and warms eager MCP
(`sdk.ts:325-330,631-634`) with no sandbox in that code path. There is nothing there to
"escape" — the boundary was never erected for an embedder, and an embedder legitimately may
already be contained (the `danger-full-access` opt-out exists for exactly that CI case,
ADR 0005's 2026-08-28 amendment). Supervisor policy inputs come from argv/global settings
per ADR 0016, which only makes sense at the CLI layer.

The two genuine escapes are both on the CLI's *own* promise:

1. **The raw-argv classifier.** `requiresSandboxedChild` (`cli-launch.ts:17-21`) scans raw
   tokens for `--help`/`--version`/`-v`/`--export`/`--list-models` without knowing which
   token is an option value or `--` tail text, while the real parser treats those
   differently (`cli/args.ts:100-112,128-132`). So `--append-system-prompt --help --mode
   rpc` or `--print -- --help` reaches `main()` on the host (`cli.ts:45,54,110-116`). This
   breaks the CLI's own ADR 0005 guarantee; a malicious repo plus one of these shapes is
   host-side session construction. This is the real escape.
2. **macOS Seatbelt profile race.** `macos-backend.ts:285-286` writes `profile.sb` inside
   the child-writable `stateDirectory` and `:301-304` feeds it to `sandbox-exec` — static,
   unverified on macOS, but a structural race on the CLI's boundary.

The audit's phrasing that "alternate SDK/RPC embedding paths weaken that guarantee" is the
overclaim to correct: an SDK embedder is not weakening a guarantee the SDK never made; the
guarantee belongs to the CLI, and the CLI's classifier (and macOS profile placement) are
what weaken it. The correct repair is to *document* the SDK boundary ("the programmatic SDK
is not sandboxed; the embedder supplies containment") and *fix* the CLI classifier.

### 2.4 Is credential/config workspace ownership contrary to the documented threat model?

**Half yes, half no — the split is child-owned vs supervisor-owned state.**

- **Child-owned config/credentials under the workspace are NOT contrary.** ADR 0005 says
  the child gets "private temporary/state paths" and the host-home and normal
  credential/session directories are denied. `buildSandboxedCliLaunch`
  (`cli-launch.ts:281-343`) allocates `.apex-code/sandbox-agent`, `.apex-code/sandbox-state`,
  and XDG dirs inside the workspace and repoints `HOME`/`TMPDIR` there. That is the
  documented design: the child's own state lives in its writable root.

- **Supervisor-owned mutable authority state inside the child-writable root IS contrary.**
  The terminal handoff latch is placed at `stateDirectory = workspace/.apex-code/sandbox-state`
  (`linux-backend.ts:138-139,144`; `macos-backend.ts:160,165`) and the supervisor writes
  `suspend`/`resume` with a plain `writeFileSync` that follows symlinks
  (`terminal-handoff.ts:67-68,82-89,150-151`). ADR 0023's premise is that the supervisor
  owns the decision because anything the child asserts is forgeable — yet the transport for
  that decision is a file the child can pre-place as a symlink, turning a supervisor (host
  uid) write into a write through the link. The same pattern applies to the synthesized git
  helper and `terminal-size` file in `stateDirectory` (`linux-backend.ts:169,220`). This
  violates ADR 0005's "private temporary/state paths" (child-private is not
  supervisor-private) and ADR 0023's supervisor-owns-the-decision, and it is the finding #5
  symlink-write result.

The contrast that proves the team already knows the right pattern: the network/credential/
escalation sockets are deliberately placed *outside* the workspace under system temp because
`AF_UNIX` `sun_path` cannot live under the workspace and "the socket now lives outside the
workspace" (`linux-backend.ts:63-72,299`). The handoff latch did not get the same treatment.
The correct fix is to move supervisor-owned mutable state to a private, child-unwritable
directory and use no-follow/descriptor-relative writes — the audit's remedy is right.

Finding #6 (host custom `APEX_CODE_POLICY_PATH` dropped at launch) is a related but
different defect: `buildChildEnvironment` (`cli-launch.ts:146-167`) forwards only an
allowlist that omits the custom policy path, so the child falls back to the visible default
`/etc/apex-code/policy.json`. That is a **silent weakening of a custom managed policy**
(fail-open for a non-default path), not a workspace-ownership violation. It is conditional
on an operator having configured a non-default policy path, so I would rate it Medium, not
High as the audit does: the default managed-policy path still enforces.

---

## 3. Challenge to the audit's overclaims

1. **Finding #4's evidence was a unit-helper probe, and the live reachability is narrower
   than "High, confirmed" implies.** The audit's `policy-probe.mts` imports
   `VerificationTracker` and `runFormatterCommand` directly — the review contract explicitly
   warns "do not call a unit helper probe end-to-end proof." The sibling corrected probe
   upgraded this to the public `AgentSession` boundary, which is the right evidence. Even
   so: `runConfiguredFormatter` is **not invoked from any CLI command, hook, or mode** in
   current source (the only callers are tests and the SDK export); `requestVerification` is
   reachable end-to-end only through the post-turn boundary
   (`agent-session.ts:1683-1685,2451-2453`) **and only when the user configured
   `boundary:"post-turn"`** (`:2362` defaults to `"explicit"`). The module-level defects are
   real; the public reachability is config- and embedder-dependent. Verdict: confirmed at
   the module boundary, qualified on reachability.

2. **"Eager MCP runs before trust" conflates a trust-boundary crossing with an OS-boundary
   escape.** In the normal CLI path the eager MCP process runs *inside* the sandboxed child,
   so the crossing is project trust, not OS containment. The OS escape only materializes
   when combined with the argv classifier (finding #2) or an SDK embedding that supplies no
   boundary. The audit's own remedy text acknowledges this ("limits that process only if
   startup actually selected the sandbox"), but the headline invites the stronger reading.
   The correct framing: eager MCP is a trust-gate defect (High); OS escape is finding #2
   alone.

3. **"SDK/RPC embedding paths weaken the sandbox guarantee" (public-comparison section) is
   the conflation of §2.3.** RPC via the CLI is still sandboxed; the SDK is a different
   audience with no boundary promised. The guarantee that is weakened is the CLI's, and the
   classifier is the weakening.

4. **The audit's overall verdict is otherwise sound and I do not refute it.** The "wiring
   defects, not missing polish" characterization, the separation of the three boundaries,
   and the repair-order skeleton all survive scrutiny. The corrections above are about
   severity labels and reachability, not about whether the defects exist.

---

## 4. Root causes and priorities (recommendations, not source edits)

These are the *seams* where the three boundaries fail, ordered by what to fix first. Each
fix reuses an existing mechanism (the canonical exec path, ADR 0010's one projection, the
trust decision) — no grand rewrite and no second capability classifier.

**R1 — One parsed command, one launch decision.**
`cli.ts:45,54` classifies raw argv with `requiresSandboxedChild` while the parser
(`cli/args.ts`) classifies typed args differently. Sandbox selection and metadata detection
must share one typed result. This decides whether *any* later control exists, so it is the
top repair. Acceptance test: drive the real public CLI with `--help`/`--version` in option
values and `--` tail text; assert the supervisor is selected (or, for genuine metadata, the
metadata path), never the host `main()`.

**R2 — Trust is not an input to project-source loaders.**
`FilePermissionRuleStore` (constructed at `main.ts:825-833` from
`store.ts:160-170`) and `createMcpRuntime` (`sdk.ts:325-330`, `mcp/config.ts:175-183`)
both read project files with no trust decision, and the trust detector's resource list
omits `permissions.json` and `.mcp.json` (`trust-manager.ts:30-38`). Thread `projectTrusted`
into every project-source loader; while untrusted, exclude project grants/modes and
`.mcp.json` (a deny-only representation may still be read separately). This is the other
half of the top priority: trust must decide what configuration can run.

**R3 — Authorization and execution do not share one operation object.**
Path matching normalizes differently from execution (`path-permission.ts:24-36` vs
`path-utils.ts:40-49`), Bash matching is lexical/whitespace-collapsed and unsupported
grammar fails open to a lower allow (`bash.ts:79-99,128-138`), and policy commands bypass
the gate entirely (`policy-executor.ts` never reads `permission`; `verification-lifecycle.ts:122`,
`formatter-lifecycle.ts:230`). Produce one canonical operation object before the gate and
execute exactly that object; tri-state deny semantics (deny matches any prohibited segment,
unknown grammar retains the restriction); preserve exact quoted bytes; route policy commands
through the canonical exec authorization path with `deny` spawn-nothing and `ask`-without-
responder refuse. This is the audit's "unify authorization and execution representations"
repair, restated as one root cause.

**R4 — Supervisor-owned authority state lives in the child-writable root and supervisor
writes follow symlinks.** Move the terminal-handoff latch, git helper, `terminal-size`, and
any other supervisor state out of `workspace/.apex-code/sandbox-state`; use no-follow/
descriptor-relative writes. Follow the pattern the socket channels already use
(`linux-backend.ts:63-72,299`).

**R5 — Host-side channels interpolate child data without validation.** Validate
`protocol`/`host` (reject CR/LF/NUL, authorize the final structured identity) in
`git-credential-proxy.ts:97-109`, and run `git credential fill` from a supervisor-owned
non-repository cwd with repository-discovery/config-injection removed
(`git-credential-helper.ts:141-166`).

**R6 — Release publishes different bytes than it tests.** The smoke gate packs and installs
tarballs (`packed-product-surface.mjs:196-205,283-303`) but the workflow re-publishes from
package directories (`release.yml:175-177,196-198`) and post-hoc verification compares
downloaded bytes against registry-supplied hashes (`verify-published-release.mjs:79-92`).
Publish the exact tested tarballs, preserve local digests, and verify provenance identity
(not only metadata field presence).

**Priority order.**

- **P0 — R1 and R2.** Parse once; trust-gate permissions and MCP. These are complete
  mediation: until they are fixed, no later control can be relied on to exist.
- **P1 — R3.** Make the boundary decide on the exact operation that executes (paths, Bash,
  verifiers, formatters).
- **P2 — R4 and R5.** Reduce the authority behind approved supervisor channels.
- **P3 — macOS escalation path and Seatbelt profile placement** (static/unverified on
  macOS; fix before any macOS claim).
- **P4 — R6 and removal of the second release authority.**

A deliberately *not* recommended item, to honor the constraint: do not build a second tool
capability/risk classifier. The existing `buildToolContractSnapshot()` projection and the
canonical exec path are the right seams; a parallel classifier would recreate ADR 0021's
drift.

---

## 5. Verdict summary

| Question | Answer |
| --- | --- |
| `declaredPaths`: enforcement or observation? | Enforcement intended (ADR 0028, spec §2); observation implemented. Audit claim #4 correct. |
| Ignored `permission`, human-chosen command | `deny` ignored = High fail-closed bug, human choice does not excuse it; `ask` ignored = Medium, human choice mitigates. |
| SDK without OS sandbox | Embedding contract (undocumented); the real escape is the CLI argv classifier + macOS profile placement. |
| Credential/config workspace ownership | Child-owned state in workspace = per ADR 0005; supervisor-owned state in workspace = contrary to ADR 0005/0023. |

**Overall:** confirm the audit's direction with three severity/classification corrections
(finding #4 reachability, finding #6 rating, and the SDK/escape conflation). The six root
causes above are the most valuable repairs; P0 (parse once + trust-gate permissions/MCP)
comes first because it decides whether every later boundary exists at all.
