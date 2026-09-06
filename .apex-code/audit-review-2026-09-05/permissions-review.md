# Permission and trust review

**Scope and status:** Read-only review of claims 1, 2, 5, 6, and 7 in the user summary against current HEAD `1964612833cddbf89e4ad61fa0921e8b42f488cc`. I read the review contract, `AGENTS.md`, `CONTEXT.md`, the original `permissions.md`, probe sources/logs, and current implementation. I did not access `c-code`, modify application source, install packages, or run live turns. Existing local changes were preserved.

## Result

**ISSUES — claims 1, 2, 5, 6, and 7 remain confirmed-static or confirmed by the supplied safe probes.** The normal permission flow is: tool arguments are prepared, extensions/hooks run, `evaluateToolCall` snapshots all rule sources, `resolvePermission` picks a matching rule, and the same arguments are executed. The critical defect is that authorization and execution do not share canonical operation facts, while project authorization inputs remain model-writable and are loaded without trust context.

### Claim 1: project authorization and self-modification — confirmed-static (High)

`FilePermissionRuleStore` always constructs project and local backends from `cwd/.apex-code` (`packages/coding-agent/src/core/permissions/store.ts:160-170`) and `snapshot()` always reads both (`:198-227`). No trust decision is an input to this store. The trust detector only examines its configured resource list (`packages/coding-agent/src/core/trust-manager.ts:180-193`); the permission files are not included. Thus an untrusted checkout can supply a project mode or allow rule before the user accepts trust. The source is labeled `project` after loading, so precedence treats it as a real project rule rather than untrusted data.

The self-modification path is also real. In `acceptEdits`, ordinary writes are auto-allowed when no rule matches; the write tool has no protected-path exception. A model can write `.apex-code/permissions.local.json`, and the next snapshot rereads that file. The existing probe recorded `self-write acceptEdits { block: false }` followed by `self-granted bash { block: false }`. A derived store's restriction on its `apply()` method does not protect the parent file from the ordinary write tool.

**Prerequisites/scope:** a write-capable session or child, and no matching managed policy or hard mode floor. The authority gained is future permission resolution for that process/session, not automatic administrator policy override. **Smallest repair:** resolve trust before constructing the store; exclude project/local grants and modes while untrusted (optionally permit a separately represented deny-only layer). Keep permission state outside model-writable workspace paths, or make it read-only and reject writes through aliases and symlinks.

### Claim 2: `@` paths and symlink aliases — confirmed-static (High)

The path permission spec normalizes with `path?.trim()` and `formatPathRelativeToCwdOrAbsolute` (`packages/coding-agent/src/core/tools/path-permission.ts:24-36`). Execution normalization uses `normalizeUnicodeSpaces: true, stripAtPrefix: true` (`packages/coding-agent/src/core/tools/path-utils.ts:40-49`). Therefore matching sees `@secret.txt` while execution removes `@` and accesses `secret.txt`. The original safe probe read the denied sentinel and logged `read @ alias content ... private`.

Matching is lexical and uses minimatch; it does not canonicalize symlink targets. A deny for `secret.txt` therefore does not constrain `alias.txt` when `alias.txt` points to it. The probe logged `read symlink bypass { block: false }`. This applies to writes as well: ordinary filesystem operations follow links after authorization.

**Prerequisites/scope:** a path-specific deny and a reachable alias/target. The bypass can read or write the denied target within whatever filesystem scope the tool already has. **Smallest repair:** produce one canonical operation object before authorization and execute exactly that object. Include `@` stripping, Unicode-space handling, and read fallback resolution in that operation. For existing paths, compare canonical targets; for new writes, use descriptor-relative no-follow checks and safely resolve the parent.

### Claim 5: deny precedence and unsupported/mixed Bash — confirmed-static (High, conditional)

`resolvePermission` selects the highest matching rule, so deny does not inherently dominate an allow at the same source. The supplied edge probe recorded `same-content allow then deny allow` and `same-content deny then allow deny`: ordering is deterministic, but same-source equal rules are not deny-first. More importantly, Bash matching requires **every** classified segment to match (`packages/coding-agent/src/core/tools/bash.ts:128-135`). A scoped deny such as `touch:*` matches a single segment, but does not match `echo ok; touch denied`; if a lower blanket allow matches, it can win. Unsupported classification also returns `false`, which permits lower matching rules to erase the intended restriction.

The original safe probe logged direct deny blocked but `bash policy chain { block: false }` and `bash policy unparseable { block: false }`. This is not contradicted by the current comments: the comments promise fail-closed behavior for unmodeled grammar, but implementation only makes scoped *allows* conservative.

**Prerequisites/scope:** a matching high-priority scoped deny plus a lower blanket allow (or equivalent permissive mode), and a command parser classification that is mixed or unsupported. **Smallest repair:** return a tri-state/richer match result. A deny must match any prohibited segment; unknown grammar must retain an unresolved restriction and prevent lower allows from authorizing. Add public gate tests, not only `PermissionSpec.matches` unit tests.

### Claim 6: exact shell approval and whitespace — confirmed-static (High)

Bash `normalizeSegment` collapses all whitespace with `text.trim().replace(/\s+/g, " ")` (`packages/coding-agent/src/core/tools/bash.ts:79-81`). `ruleForCall` stores that normalized segment (`:142-149`). Consequently an approval for a command containing a quoted space/newline can match a different byte sequence whose shell meaning changes. The safe exact probe logged `changed command matches true`; the original command created no marker, while the changed quoted-newline command did create `marker`.

**Prerequisites/scope:** an exact approval for a command with quoted whitespace and a later altered command supplied to the same session. The gained authority is execution of the altered command under the original approval. **Smallest repair:** preserve exact parsed token/quoted bytes for exact approvals, or reject any approval containing grammar-sensitive whitespace and require a fresh ask. Test the public gate followed by execution, including tabs, newlines, comments, quoting, and escaped characters.

### Claim 7: generated path grants and glob expansion — confirmed-static (Medium)

The path contract says `ruleForCall` returns an exact path, but the resulting text is passed back through minimatch (`path-permission.ts:29-36`). A literal filename such as `*.txt` becomes a pattern and authorizes siblings. The probe recorded `generated path rule *.txt authorizes other.txt true`. This is a trust/permission correctness issue, not merely a display issue.

**Smallest repair:** represent generated exact-path rules separately from user globs, or escape minimatch metacharacters before persistence. Add a round-trip test proving the approved unusual filename matches and a sibling does not.

## Highest-value acceptance tests

1. Public session with `projectTrusted:false` and a project permission file: project mode/grants must be ignored; explicit trust must enable them.
2. In `acceptEdits`, attempt the real write tool against both permission files and a symlink to one; both must block or require operator approval, and a subsequent snapshot must not change authorization.
3. Gate then execute `read({path:"@secret.txt"})` and a symlink alias under a deny for the canonical target; neither may read it.
4. Managed deny `touch:*` plus lower blanket allow: direct, chained, redirected, quoted-newline, and unsupported Bash inputs must never execute `touch`.
5. Approve exact `sh -c` input, then alter quoted whitespace/newline: altered input must not reuse approval. Verify marker absence.
6. Approve literal paths `*.txt`, `[a].txt`, and names containing Unicode spaces; each must authorize only its exact target.

## Gaps and evidence limits

The original probes target an earlier audit checkout, so their runtime outputs are historical evidence, not a fresh claim that behavior was reproduced on HEAD. The current source confirms the relevant code paths and unchanged defects statically. I did not rerun TypeScript probes because the contract forbids source edits and requires inspecting reproduction scripts before execution; the supplied probes were inspected and their logs are cited. Existing permission tests passing (120/120 in the audit log) does not cover these public-boundary compositions.
