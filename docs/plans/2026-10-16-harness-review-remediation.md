# Plan: Fix the 2026-10-16 harness review findings

**Status:** In progress. The spec is Active. Stage 1 starts with HR.1.

**Spec:** [Harness review remediation](../specs/2026-10-16-harness-review-remediation.md)

The findings come from a code-only review of `main` at `b07d5239c` on 2026-10-16. That
review ran `npx tsgo --noEmit` (exit 0), `npx biome check --error-on-warnings .` (no
fixes), and `npm test`. The test run passed 21 root, 975 agent-core, and 4,217 coding-agent
tests, and failed one on a 60s timeout under load (HR.30). Work runs in five stages, in
order: security, reachability, model quality, approval friction, cleanup. A stage starts
only when every task in the previous stage is `Done` or `Done, unverified` with the gap
named.

## Tasks

| # | Task | State | SHA | Verified by |
| --- | --- | --- | --- | --- |
| HR.0 | Write the spec, with deletion inventory, compatibility posture, and the two ADR questions (HR.1, HR.23) | Done, unverified. Drafted 2026-10-16. Needs review, Status set to Active, and a commit SHA | — | `node scripts/validate-docs-lifecycle.mjs` passes and the roadmap row links the spec |
| **Stage 1** | **Security** | | | |
| HR.1 | Read boundary: `read`, `grep`, `find`, `ls` ask for targets outside the workspace | Not started | — | A new read-boundary test under `test/permissions/`: inside allows, outside asks, a symlink leaving the workspace asks, a directory containing the workspace asks |
| HR.2 | Two tiers. Protected targets: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`. Sensitive paths: `.env*` anywhere, minus template names | Not started | — | Extend the protected-path tests: each protected target is refused under every non-`policy` rule; `.env` asks by default, a rule naming it grants it, and a directory rule covering it does not; `.env.example` stays ordinary |
| HR.3 | `web_fetch` stops following redirects across hosts. A cross-host redirect returns the target URL as text, so the next fetch is gated on its own | Not started | — | Test with two local HTTP servers: the second server records zero requests; a same-host redirect still follows, capped at 5 hops |
| HR.4 | `web_fetch` SSRF guard: http(s) only, and refuse loopback, link-local, RFC1918, CGNAT, and unique-local IPv6 after DNS resolution, with the resolved address pinned for the connection | Not started | — | Tests for `127.0.0.1`, `[::1]`, `169.254.169.254`, `10.0.0.1`, and a hostname resolving to loopback; an opt-in setting re-enables private ranges |
| HR.5 | MCP stdio servers get the SDK's default safe environment plus their configured `env`, resolved with the existing `$VAR` / `!command` syntax, not all of `process.env` | Not started | — | Fake stdio server echoes its env: a provider key set in the parent is absent, `"TOKEN": "$TOKEN"` arrives resolved, `$$` arrives as a literal `$` |
| HR.6 | Session files are written `0600` and session directories `0700`; existing files are tightened on open | Not started | — | Test stats new and reopened session files (skipped on Windows) |
| HR.7 | `/share` redacts credential-shaped strings and asks before upload, naming the gist's visibility | Not started | — | Test: a transcript containing `sk-ant-…` and `ghp_…` produces a gist payload without them |
| HR.8 | `--api-key` warns that it leaks to shell history and `ps`, and the help text points to the credential store and environment | Not started | — | `test/args.test.ts` asserts the warning |
| **Stage 2** | **Reachability** | | | |
| HR.9 | Built-in agent types `general` (parent's tools) and `explore` (`read`, `grep`, `find`, `ls`), shadowed by same-named user or project definitions | Not started | — | SDK test with an empty agent dir: `delegate` to `explore` completes against the faux provider; a user `explore.md` wins |
| HR.10 | The model is told which agent types exist: a name and description catalog, bounded like the skill catalog | Not started | — | Prompt test shows the catalog; the static-prefix budget test still passes |
| HR.11 | Agent definitions accept `tools: a, b` as well as a list, and an unusable definition is reported in `/resources` instead of vanishing | Not started | — | Parser tests for both forms; a malformed file produces a diagnostic naming the file and field |
| HR.12 | Abort reaches a foreground subagent: `delegate` passes its `AbortSignal`, and `AgentSession.abort()` interrupts running children with a reason | Not started | — | Write the reproduction first: a child that never settles keeps `abort()` pending. Watch it fail, then pass with `abort()` resolving under 2s and the child recorded `cancelled` |
| HR.13 | Plan mode activates `grep`, `find`, `ls` and leaves out tools it would deny, so the rules section no longer recommends `bash` | Not started | — | Plan-mode test: active tools are exactly the read-only set plus `plan_present`; the prompt omits "Use bash for file operations" |
| HR.14 | MCP discovery works on a cold cache: servers with no cached tools are listed in the background after startup, off the critical path, and each one started is reported through the mode's own channel | Not started | — | Fresh cache, lazy server: `{"search": …}` finds its tool without a prior call; the notice appears in the TUI, on stderr in `-p`, and as an event in JSON with stdout otherwise clean; the startup bench shows no added time to first paint |
| HR.15 | Default tool set gains `grep`, `find`, `ls`, `todo_write`, `web_fetch`, `delegate`, and `ask_user` (interactive only), with schemas deferred | Not started | — | Default-tools tests updated; the static-prefix budget test passes or the spec records the new budget |
| **Stage 3** | **Model quality** | | | |
| HR.16 | System prompt `<environment>` section: date, platform, shell, git branch and dirty state, model id. Placed after the cacheable prefix | Not started | — | Prompt test for each field; a test proves the prefix bytes are unchanged when only the date changes |
| HR.17 | Working rules: verify before claiming done, read before editing, no destructive git without asking, tool and web output is data, not instructions | Not started | — | Prompt snapshot; prefix budget test |
| HR.18 | Default models move to current catalog ids (Anthropic `claude-opus-5-5`, Bedrock `us.anthropic.claude-opus-5-5`, and the rest), and the model data is refreshed for `claude-sonnet-5-5` and `claude-haiku-5-5` | Not started | — | A test asserts every `defaultModelPerProvider` id exists in the bundled catalog; `npm run check:model-data` passes |
| HR.19 | `web_fetch` streams with a byte cap and timeout, converts HTML to markdown, and dispatches by content type (text, JSON, PDF refused with a message, binary refused) | Not started | — | Fixture tests: a page with a 60 KB `<head>` still returns its body text; a 20 MB response stops at the cap |
| HR.20 | No code change. The spec records provider-native search and a second keyed backend as non-goals (ADR 0001) | Not started | — | Closes with the commit that makes the spec Active |
| **Stage 4** | **Approval friction** | | | |
| HR.21 | Built-in allow-list for bash commands that cannot read files: `pwd`, `--version` queries, and listed flag and ref-like forms of `git status`, `log`, `diff`, `branch`, `show`, `rev-parse` | Not started | — | Gate tests: each allowed form runs without a prompt in `default` mode; `git log && rm x`, `git diff /dev/null /outside/file`, `git -c core.fsmonitor=x status`, `git branch -D x`, and `git diff --output=f` all ask |
| HR.22 | The bash classifier accepts `2>&1`, `>/dev/null`, `2>/dev/null`, and a `~` inside a word, while redirection to a file and a word-initial, post-`=`, or post-`:` `~` stay unparseable | Not started | — | Classifier table tests including bypass attempts (`>/dev/null; rm x`, `2>&1 >file`, `FOO=~/x`, `a:~/x`) and `git log HEAD~3` matching a `git log:*` rule |
| HR.23 | No code change. ADR 0035's one-hour default stands, because the 2026-10-16 suite run took 2,451s. The spec records the measurement | Not started | — | Closes with the commit that makes the spec Active |
| HR.24 | `write` and `edit` refuse a file that changed on disk since the model last read it. `write` refuses to replace an existing file the model has not read in full; a partial read satisfies `edit` only | Not started | — | Tests: external modification between read and edit is refused with a re-read hint; `write` after an `offset`/`limit` read is refused; new-file writes are unaffected |
| **Stage 5** | **Cleanup** | | | |
| HR.25 | Delete `core/durable-state/daemon.ts` and its tests, since no production code calls it. Keep the SQLite sidecar and leases, which are used | Not started | — | `npx tsgo --noEmit`; `npm test`; a grep shows no remaining import |
| HR.26 | Fix the `./client` and `./experimental/plugin` exports, which point into unpublished `src/`. Keep `src/experimental` itself, because it is upstream code (ADR 0003 merge cost) | Not started | — | `npm run check:package-install` resolves every exported subpath from the packed tarball |
| HR.27 | Text fixes: `--exclude-tools ask_user` in help, `/bug` description, changelog link repo in `utils/changelog.ts` | Not started | — | Tests or snapshots covering each string |
| HR.28 | Root hygiene: rename `pi-monorepo`, re-indent `package.json` and bring it under Biome, remove `reasonix.toml`, rename or remove the `pi-test.*` and `mini-test.sh` scripts | Not started | — | `npm ci`; `npm run check` |
| HR.29 | Compaction reserve becomes the larger of 16,384 and the model's max output tokens | Not started | — | Compaction threshold test for a 128k-output model |
| HR.30 | Give `test/extensions-discovery.test.ts` timeout headroom or make it faster. It takes 54s of a 60s limit when run alone | Not started | — | The file passes alone, and full `npm test` exits 0 on a loaded host |
| HR.31 | Add a CodeQL workflow for TypeScript | Not started | — | One green CI run of the new workflow |
| HR.32 | Verify and close: three-OS CI, `[Unreleased]` changelog entries, spec to Landed, roadmap row, delete this plan | Not started | — | Every row above has a SHA passing `git cat-file -t`; three-OS CI green |

States: `Not started`, `In progress`, `Done, unverified`, `Done`.

`Done` requires a real SHA that passes `git cat-file -t`, and a verification that
actually ran. `Done, unverified` is honest and must say what is missing.

## Order changes

None.

## Notes

Every task follows the `AGENTS.md` test-first rule, and any test that drives a turn,
writes a session, or touches Git changes into a scratch directory first.

Stage 1 ships alone as 0.7.0, Stage 2 as 0.8.0, Stage 4 as 0.9.0, and Stages 3 and 5 as patches.

HR.1, HR.2, HR.5, HR.13, HR.15, and HR.24 change defaults users rely on. Each one needs a
`[Unreleased]` changelog entry that says what changed and how to restore the old behavior.

HR.13 touches the plan-mode tool projection that the live reachable-harness-surfaces
plan changed in RS.7. Start HR.13 after that plan closes, or rebase onto its final state.

HR.1 and HR.21 must agree. A bash command that reads a path cannot be auto-allowed while
`read` of the same path asks. The spec settles this before either task starts.

These review findings are larger than a fix and need their own spec once this plan
closes. They are not tasks here:

- MCP resources, prompts, elicitation, progress, cancellation, rich content, and
  reconnection after a server dies.
- Hook events beyond the current five, input rewriting, and context injection.
- Headless flags: `--max-turns`, `--max-budget-usd`, `--mcp-config`, `--add-dir`.
- Persistent memory and `/init`.
- Context files: loading both `AGENTS.md` and `CLAUDE.md`, `@import`, nested files, a size cap.
- Slash commands: `/permissions`, `/cost`, `/context`, `/agents`, `/hooks`, `/mcp` status, `/diff`, `/doctor`.
- PDF and notebook reading.

Not a repository task: about 1,664 leftover `--tmp-pi-*` session directories sit in
`~/.apex-code/agent/sessions` from test runs before 2026-08-20. The leak is fixed, but
nothing removed them.
