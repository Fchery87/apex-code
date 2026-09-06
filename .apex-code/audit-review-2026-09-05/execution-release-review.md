# Execution and release review

## Verdict

ISSUES. The five assigned findings remain valid at HEAD `1964612833cddbf89e4ad61fa0921e8b42f488cc`. None establishes a compromised release or an unconditional host sandbox escape. Eager MCP, denied verification, and formatter scope violations were reproduced through session creation and public session methods. Release integrity and legacy workflow authority are confirmed by current source; the registry comparison weakness was reproduced at its exported comparison boundary.

Read-only review. I read AGENTS.md, CONTEXT.md, the review contract, the original report, execution-wiring.md, execution-ci.md, applicable TypeScript and boundary/type-system principles. I did not access prohibited source. Existing local modifications were preserved. No installs, publication, provider turns, network probes, or application edits ran. Reports and probes are under this directory. A targeted `git diff 2477e594ef1479d1cb4467f0bc50c2e14fcd3e00 HEAD --stat --` over the reviewed MCP, SDK, policy, session, release workflow and verifier paths exited 0 with empty output. I also read the current files rather than relying on that comparison.

## Findings and scope corrections

### E1. Eager MCP ignores explicit project distrust

High, reproduced-now at the session API; CLI chain confirmed-static.

- `packages/coding-agent/src/main.ts:768-805` resolves trust and constructs settings with that result.
- `packages/coding-agent/src/core/sdk.ts:325-330` creates MCP using only cwd and connector. It does not pass trust. Lines 631-634 warm eager servers unconditionally, including sessions with no tools.
- `packages/coding-agent/src/core/mcp/runtime.ts:25-34` supplies the project file to configuration loading. `mcp/config.ts:175-183` merges it and permits project names to replace global names.
- `mcp/server-manager.ts:129-139` opens eager connections. `mcp/connector.ts:34-45,72-74` constructs the configured stdio or HTTP transport; stdio gets the process environment.
- `packages/coding-agent/src/core/trust-manager.ts:30-38,185-193` never checks root `.mcp.json` as a trust resource.

The new probe created a real session with `projectTrusted:false`, `tools:[]`, and a proper plan-mode permission-gate options object. A project Node MCP command wrote its scratch marker before any model turn. No credentials were supplied; the probe clears inherited environment entries except PATH and SystemRoot, and uses scratch HOME and agent state. The corrected probe's `trustRequiringResources=true` comes from ancestor resources in this checkout, not detection of `.mcp.json`. Do not cite it as proving root MCP discovery. The omission is confirmed by the source.

Prerequisite is repository-supplied eager config plus session startup. Authority is that of the session process. The normal supervised CLI still confines the command; an SDK embedding has no implicit sandbox. Eager startup itself is deliberate: `docs/specs/2026-08-28-native-mcp.md:97-104` explicitly permits it. The defect is treating repository configuration as approved despite distrust, not the existence of eager lifecycle. Child construction also uses the same SDK path with inherited settings and restricted tool names at `sdk.ts:549-562`; no delegated turn was run here.

Smallest repair: make the approved configuration sources explicit in the MCP loader and omit project entries while untrusted. Include root `.mcp.json` in trust-resource discovery. Decide and test how startup authority is capped for delegated/no-MCP sessions, rather than assuming the proxy tool's permission contract governs process startup.

### E2. Configured commands ignore permission ceilings

High, reproduced-now at public `AgentSession.requestVerification()` with a plan-mode gate configured.

`packages/coding-agent/src/core/policy-loader.ts:165-190` accepts deny/ask and defaults to ask. `agent-session.ts:2372-2383` calls the tracker without authorization. `verification-lifecycle.ts:112-124` directly invokes `runPolicyCommand`. That executor checks cancellation and lexical cwd containment, then calls `spawn` at `policy-executor.ts:125-180`. No declared permission, session mode, canonical contract or responder enters this execution path. Formatter wiring has the same omission at `agent-session.ts:2392-2408`.

The corrected probe loaded a user policy marked `permission:"deny"` from a real scratch settings file. Public verification returned `verified`, with evidence `status:"passed"`, exitCode 0. The plan-mode gate's store was never consulted. Public formatting also executed despite that gate. The original audit tested lifecycle helpers; this review adds public-session evidence. An initial attempt mistakenly passed a function instead of gate options. Its log is retained and disqualified as plan-gate proof. Only the corrected probe supports that claim.

Scope: project policies do require trust, unlike MCP. `policy-loader.ts:262-265` omits them when untrusted. The attacker needs trusted project configuration, an existing user policy that invokes repository code, or a caller with the ability to configure/invoke policies. This is not arbitrary untrusted repository policy loading. There is a real post-turn path: `agent-session.ts:1683-1685,2451-2453`. I confirmed it statically but did not drive a turn. Searches of CLI modes found no direct calls to the explicit public verification/formatter methods. Do not claim a demonstrated slash command or RPC operation.

This violates the landed spec at `docs/specs/2026-09-01-configured-verification-and-formatting.md:113-129,157,171`. Route policy invocation through a canonical exec authorization boundary before spawn. Model policy permission as an additional ceiling, never an alternate allow path. Deny spawns nothing; ask without a responder refuses. Enforce this for explicit verification, post-turn verification and formatting. Do not implement an unrelated second capability classifier.

### E3. Formatter scope observes writes but does not restrict them

High for the promised write boundary, reproduced-now at public `AgentSession.runConfiguredFormatter()`.

`formatter-lifecycle.ts:201-220` rejects unsafe pattern strings. Lines 223-245 snapshot the workspace, execute the unrestricted command, and classify changes afterward. Lines 251-272 preserve process status even when writes are undeclared or escaped. The corrected public probe declared only `allowed.txt`, wrote `unrelated.txt`, returned `passed`, reported that undeclared path, and left the file in place.

This is explicitly contrary to refusal promised by the landed spec at lines 123 and 158. Existing tests encode the weaker implementation: `packages/coding-agent/test/formatter-lifecycle.test.ts:84-118,130-149` expect `passed` for undeclared/pathScope and symlink violations. Passing those tests is not acceptance of the spec.

Prerequisite is an invoked configured formatter, including accidental broad formatting. Authority is the session's filesystem access, not unrestricted host access in the supervised CLI. A plain SDK embedding can write outside the workspace; symlink escape was not rerun here. The snapshot is not even a complete write audit: it skips directories and applies budgets at `formatter-lifecycle.ts:98-147`. Transient changes or untouched-prefix changes are not prevention tests.

Smallest honest mitigation: stop reporting policy success for detected violations and disable unrestricted formatter execution where scope must be guaranteed. Full repair needs per-invocation confinement or isolated execution with promotion of only validated declared changes. A git worktree alone is not a sandbox: a malicious formatter can still use absolute paths or network access unless separately constrained. Do not revert arbitrary live-workspace files after the command; that risks deleting concurrent user work.

### CI-1. Publication is not bound to tested package bytes

High release-integrity assurance defect, confirmed-static; comparison weakness reproduced-now. No compromised release observed.

`packed-product-surface.mjs:105-117,197-203,283-303` packs and smoke-installs real tarballs but retains only filenames in the report. `.github/workflows/release.yml:175-198` then publishes package directories, not those tested tarballs. Its verifier invocation at lines 232-241 passes only names, versions and the tag SHA.

`scripts/apex/verify-published-release.mjs:49-76` checks gitHead and attestation URL/predicate presence. Lines 79-104 compare downloaded bytes only with registry-reported digests. There is no expected local digest and no signature, subject or workflow identity verification. Line 155 nevertheless says provenance is verified. The new offline comparison probe accepted fabricated hashes and a nonexistent attestation URL, returning `{"metadataProblems":[],"tarballProblems":[]}`. This is exported comparison-function evidence, not an end-to-end registry attack.

Prerequisites include changed package content between smoke and publication, a compromised publishing component, or substituted registry responses. This gap grants no publication credentials to a normal PR author. `docs/adr/0018-apex-only-release-version-authority.md:28-38` explicitly requires registry content to agree with what CI built. Signed-provenance verification is a separate missing assurance from local byte identity; retain both repairs, but do not imply merely passing `--provenance` verifies the received signature.

Repair: preserve local artifact digests before smoke, publish those exact files, compare downloaded registry bytes with those immutable digests, and verify signed provenance against expected subject/repository/workflow/ref identity. Correct success wording until each guarantee exists.

### CI-2. Inherited workflow retains a second release authority

Medium, confirmed-static. Disable before the next tag, even though it is currently broken.

`.github/workflows/build-binaries.yml:3-16,31-39` triggers on `v*` or manual dispatch with independent `source_ref`. Its concurrency group differs from `release.yml:7-9`. Lines 93-104 expect `pi-*` binary archives while `scripts/build-binaries.sh:252-260` emits `apex-code-*`. This mismatch blocks normal progress; it is not a security control.

The workflow still grants `contents:write` at lines 202-209,387-415,417-440 to stage, publish or delete releases. It also retains an npm job with `id-token:write`, environment `npm-publish`, and `scripts/publish.mjs` at lines 296-344. That script performs a dry-run pack at lines 44-47 then publishes at line 108 without the intended packed smoke and post-publication gates. This contradicts `docs/release-governance-checklist.md:27-30`. Existing regression tests inspect only `release.yml`, see `scripts/release-workflow.test.mjs:6-10`.

No live GitHub permissions, environment protection or npm Trusted Publishing binding was inspected. Do not promote the workflow into proof that legacy npm publication can authenticate today. Manual `source_ref` recovery still gives a possible route around accidental artifact incompatibility to authorized dispatchers. Delete this workflow or remove all release/publish authority and tag triggers. Recovery should reuse the sole approved release path, not repair this second publisher's filenames.

## Priorities and release acceptance

1. Block untrusted MCP startup first. Test the packaged CLI with rejected trust and explicit distrust, a root-only `.mcp.json`, eager stdio marker and local HTTP listener. Assert no spawn, no connection and no global-name override. Repeat at SDK session creation with no tools and delegated read-only settings. Use a fake provider or startup-only RPC lifecycle, not a live provider request.
2. Block configured-command execution until canonical permission ceilings apply. At public session boundaries, test deny, ask without responder, declined ask, managed deny, plan mode and approved allow. Assert actual marker absence, not only return status. Cover post-turn with an offline scripted provider and explicit formatter calls.
3. Require formatter scope tests to verify bytes outside the declared set remain unchanged. Include symlink targets, cwd symlinks, traversal, undeclared creation/deletion, skipped directories, absolute writes, descendants and concurrent user edits. A status-only failure test does not prove confinement.
4. Disable the inherited publisher immediately, independently of runtime repairs. Scan every workflow/job and invoked publisher script for release mutation, npm publication and OIDC authority. Test tag and recovery paths against the single authority rule.
5. Gate the next publication on exact-artifact identity. Record digests before smoke, mutate the package directory afterward and prove only the original tarballs are published. Reject a substituted tarball with matching registry metadata and expected gitHead. Reject missing, forged, wrong-subject and wrong-workflow signed attestations. Include both owned packages and retained release evidence. Confirm external deployment and npm identity settings with a maintainer before release; repository tests cannot establish them.

Keep standalone archive signing separate from these defects. `docs/specs/2026-08-25-standalone-release-installer.md` explicitly excludes independent signing. Strengthening that policy is valid follow-up, not proof the existing choice was secretly broken.

## Checks and gaps

PASS: 22 offline existing workflow/verifier checks. Four registry-network tests were excluded by name. This confirms only their current assertions, including the weaker release comparison model. No full suite, typecheck, install smoke, macOS run or live release verification was performed. No application edits were made, so implementation-completion gates are not claimed.

The exact commands and full outputs are in:

- `execution-session-probe-corrected.log`, exit 0. Public session MCP and configured-policy probe. Output includes `projectTrusted= false mcpCommandExecuted= true`, `publicVerification= verified`, and `publicFormatterStatus= passed undeclaredPaths= [ 'unrelated.txt' ] undeclaredWritePersisted= true gateCalls= 0`.
- `execution-release-comparison-probe.log`, exit 0. Output `{"metadataProblems":[],"tarballProblems":[]}`.
- `execution-workflow-tests.log`, exit 0. Actual summary `tests 22`, `pass 22`, `fail 0`, `duration_ms 4093.102836`.

Commands used the repository Node/tsx loader with scratch cwd. The public probe uses an initialized scratch git repository and clears inherited environment values. It does not call `session.prompt()`. Probes retained here derive from the inspected original scripts and use fresh locations to avoid stale markers. The first probe's malformed gate parameter and an attempted read of a nonexistent workspace-observation path were reviewer errors, not product failures. The corrected probe is the evidence used above.

BLOCKED/unverified: signed provenance acceptance against actual registry data, live GitHub/npm policy, successful inherited publication, sandboxed CLI integration for these cases, delegated MCP startup, post-turn denial and symlink confinement on each supported OS. No finding above depends on treating those gaps as reproduced attacks.
