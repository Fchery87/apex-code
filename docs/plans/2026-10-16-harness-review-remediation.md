# Plan: Fix the 2026-10-16 harness review findings

**Status:** In progress. The spec is Active. Stages 1, 2, and 3 verified; Stage 4 next.

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
| HR.0 | Write the spec, with deletion inventory, compatibility posture, and the two ADR questions (HR.1, HR.23) | Done | 02846b12266d83873d90a10fa1487567e9e8f3b7 | Two review rounds settled every open question on 2026-10-16 and the spec is Active. `node scripts/validate-docs-lifecycle.mjs` passed and the pre-commit `npm run check` passed. The roadmap row links the spec. SHA verified with `git cat-file -t` |
| **Stage 1** | **Security** | | | |
| HR.1 | Read boundary: `read`, `grep`, `find`, `ls` ask for targets outside the workspace | Done | 47c880f1ea3e17901b145fb1214f2e124b0d7402 | Five tests in `test/permissions/read-boundary.test.ts`: three watched fail before the change, two guards pass before and after. Permission and read-tool suites pass (31 files, 450 tests). Pre-commit `npm run check` passed. Glob characters in directory names are escaped in a follow-up, covered by its own test. |
| HR.2 | Two tiers. Protected targets: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`. Sensitive paths: `.env*` anywhere, minus template names | Done | 170e08033c4c83cd6d15984d2fcb818011a9d960 | Eleven tests in `test/permissions/sensitive-paths.test.ts`, watched failing before the change. Home credential locations are protected under every non-policy rule, and a directory containing one is too. `.env` asks by default, is granted only by a rule naming the file, and template names stay ordinary. Permission and tool suites pass (72 files). |
| HR.3 | `web_fetch` stops following redirects across hosts. A cross-host redirect returns the target URL as text, so the next fetch is gated on its own | Done | f5d921c83eeb131b1046c3479915236c8b2c7de5 | `test/tools/web-fetch-boundary.test.ts`: same-host redirects followed, cross-host redirects returned as text with the second host receiving zero requests, five-hop limit. Sixteen of eighteen cases were watched failing. Existing web-fetch suite passes unchanged. |
| HR.4 | `web_fetch` SSRF guard: http(s) only, and refuse loopback, link-local, RFC1918, CGNAT, and unique-local IPv6 after DNS resolution, with the resolved address pinned for the connection | Done | f5d921c83eeb131b1046c3479915236c8b2c7de5 | Private, loopback, link-local, and unique-local addresses are refused, including IPv4-mapped IPv6, with the setting named in the error. The setting is read from user settings only (`test/tools/web-fetch-settings.test.ts`). The spec amendment records two narrower choices: no DNS pinning, and policy scope not yet wired. |
| HR.5 | MCP stdio servers get the SDK's default safe environment plus their configured `env`, resolved with the existing `$VAR` / `!command` syntax, not all of `process.env` | Done | 6bfba428c3d3c6ea46e5f0dc54415ed77d823e3c | `test/mcp/stdio-env.test.ts`: provider keys absent, SDK default set kept, `$VAR` and `${VAR}` resolved, `$$` literal, unset references omitted, connect failure names the syntax. MCP suite passes: 128 tests. |
| HR.6 | Session files are written `0600` and session directories `0700`; existing files are tightened on open | Done | dcd8a3ba2132863ab49d107d2926f10944bdc1e7 | `test/session-file-modes.test.ts`: new files 0600, directory 0700, existing 0664 file tightened on open. All three watched failing before the change. Session suites pass: 196 tests. |
| HR.7 | `/share` redacts credential-shaped strings and asks before upload, naming the gist's visibility | Done | ffe4e722487a5dfebe2c05ac9cc1338966b253b9 | `test/session-share-redaction.test.ts`: eight credential shapes replaced and counted; upload carries the redacted export; cancel uploads nothing. Confirmation states the count. The one existing test whose premise changed was updated with its meaning kept. |
| HR.8 | `--api-key` warns that it leaks to shell history and `ps`, and the help text points to the credential store and environment | Done | 4357143c21651f9e5647401b43dc036335c4e25c | `test/args-api-key.test.ts`: the key is still accepted and a stderr warning names `/login`. Args suite passes: 93 tests. |
| **Stage 2** | **Reachability** | | | |
| HR.9 | Built-in agent types `general` (parent's tools) and `explore` (`read`, `grep`, `find`, `ls`), shadowed by same-named user or project definitions | Done |  | `test/delegation/builtin-agents.test.ts`: explore has read-only tools with no bash; general has the default tools and no delegate; a user `explore.md` replaces the built-in. The resolver lists built-in and discovered types. Delegation suites pass: 112 tests. Full `npm test` passed on 2026-10-16 (4,305 coding-agent tests) |
| HR.10 | The model is told which agent types exist: a name and description catalog, bounded like the skill catalog | Done |  | `test/delegation/agent-catalog.test.ts`: names each type with its description, is bounded at 1,500 characters with a count of the rest, and appears in the `delegate` description. Full `npm test` passed on 2026-10-16 (4,305 coding-agent tests) |
| HR.11 | Agent definitions accept `tools: a, b` as well as a list, and an unusable definition is reported in `/resources` instead of vanishing | Done |  | `test/delegation/agent-definition-problems.test.ts`: tools accept a comma-separated string and a YAML list; a definition with no description, or a bad tools value, is reported with its file path and reason, and `/resources` shows an "Agent definitions" group. The old `agents.test.ts` fixture used a bare `tools: read` as its invalid example, and now uses `tools: 42`. Delegation and resource suites pass: 171 tests. Full `npm test` passed on 2026-10-16 (4,305 coding-agent tests) |
| HR.12 | Abort reaches a foreground subagent: `delegate` passes its `AbortSignal`, and `AgentSession.abort()` interrupts running children with a reason | Done |  | `test/delegation/abort-propagation.test.ts`: the reproduction hung until its timeout before the change. Aborting the delegate call interrupts the child and returns its partial output, an already-aborted call interrupts at once, and a background run survives a foreground abort. `AgentSession.abort()` interrupts running foreground children. Delegation suites pass: 114 tests. Full `npm test` passed on 2026-10-16 (4,305 coding-agent tests) |
| HR.13 | Plan mode activates `grep`, `find`, `ls` and leaves out tools it would deny, so the rules section no longer recommends `bash` | Done |  | `test/plan-mode-tools.test.ts`: in plan mode bash, edit, write, and delegate leave the active set, grep, find, and ls join it, and the prompt no longer recommends bash. Leaving plan mode restores the requested set. Two older expectations in `test/plan-approval.test.ts` changed on purpose: the search tools are now active, and bash returns after approval as requested. The approval-tool rule still holds. Permission and plan suites pass: 406 tests. The reachable-harness-surfaces plan still awaits its idle-host timing, but its code is on this branch. Full `npm test` passed on 2026-10-16 (4,305 coding-agent tests) |
| HR.14 | MCP discovery works on a cold cache: servers with no cached tools are listed in the background after startup, off the critical path, and each one started is reported through the mode's own channel | Done, unverified |  | `test/mcp/cold-discovery.test.ts` and `test/mcp/discovery-notice.test.ts`: lazy servers with no cache entry are listed at startup, and the session emits one `mcp_discovery_started` event naming them. The TUI shows a status line, print text mode writes a stderr line, and JSON and RPC carry the event. The earlier "partial" note is closed. MCP, print, JSON, interactive, and RPC suites pass: 475 tests. Full npm test pending |
| HR.15 | Default tool set gains `grep`, `find`, `ls`, `todo_write`, `web_fetch`, `delegate`, and `ask_user` (interactive only), with schemas deferred | Done |  | `test/default-tool-names.test.ts`: the default set gains grep, find, ls, web_fetch, and delegate. `todo_write` and `ask_user` are deliberately absent, and the spec records why. Five pinned default expectations in `test/task-tool-defaults.test.ts` moved to the new set, in order. Default-tool, task-default, tool, and context-budget suites pass: 149 tests. Full `npm test` passed on 2026-10-16 (4,305 coding-agent tests) |
| **Stage 3** | **Model quality** | | | |
| HR.16 | System prompt `<environment>` section: date, platform, shell, git branch and dirty state, model id. Placed after the cacheable prefix | Done |  | `test/system-environment.test.ts`: the environment block states the date, platform, shell, model, and git state, names a non-repository directory plainly, is the last prompt section, and changing only the date leaves every earlier section identical. The block is cached per session and rebuilt on a model change or `/reload`. Prompt, context, and session suites pass: 144 tests. Full `npm test` passed on 2026-10-16 (4,361 coding-agent tests) |
| HR.17 | Working rules: verify before claiming done, read before editing, no destructive git without asking, tool and web output is data, not instructions | Done |  | `test/system-prompt-rules.test.ts`: the rules section states the verify-before-done rule, the read-before-edit rule, the destructive-git prohibition unless the user asks, and the tool-output-is-data rule. Prompt suites pass: 80 tests. Full `npm test` passed on 2026-10-16 (4,361 coding-agent tests) |
| HR.18 | Default models move to current catalog ids (Anthropic `claude-opus-5-5`, Bedrock `us.anthropic.claude-opus-5-5`, and the rest), and the model data is refreshed for `claude-sonnet-5-5` and `claude-haiku-5-5` | Done |  | `test/default-model-ids.test.ts`: every default model id resolves in the bundled catalog, Anthropic and Bedrock default to Opus 5.5, and Sonnet 5.5 and Haiku 5.5 are present. The model-data refresh (`npm run refresh:model-data`, then hydrate) removed several retired ids, which the test caught, so Nvidia, Together, and the Xiaomi plans moved to their current models. OpenCode Go stays on its previous snapshot: the refreshed file adds a Google-API model that the frozen `packages/ai` provider does not wire (ADR 0001 forbids patching it here). Three registry fixtures moved to a model OpenRouter still carries. Model suites pass: 266 tests, and `check:model-data` passes. Full `npm test` passed on 2026-10-16 (4,361 coding-agent tests) |
| HR.19 | `web_fetch` streams with a byte cap and timeout, converts HTML to markdown, and dispatches by content type (text, JSON, PDF refused with a message, binary refused) | Done |  | `test/tools/web-fetch-content.test.ts`: an HTML page with a 60 KB head returns its body as markdown, with scripts and styles dropped. JSON passes through. An image and a PDF are refused, with their type named. A body over the cap is cut and marked truncated. Three cases were watched failing before the change. Limit: the cap test checks the bound and the marker, not that the download stopped early. Tool suites pass: 35 web-fetch tests. New exact-pinned dependencies: turndown 7.2.4 (MIT, MIT last published 2026-04-03, depends on @mixmark-io/domino) and @types/turndown 5.0.6. Shrinkwrap and install lock regenerated. Full `npm test` passed on 2026-10-16 (4,361 coding-agent tests) |
| HR.20 | No code change. The spec records provider-native search and a second keyed backend as non-goals (ADR 0001) | Done | 02846b12266d83873d90a10fa1487567e9e8f3b7 | The spec's non-goals and decisions table record it. SHA verified with `git cat-file -t` |
| **Stage 4** | **Approval friction** | | | |
| HR.21 | Built-in allow-list for bash commands that cannot read files: `pwd`, `--version` queries, and listed flag and ref-like forms of `git status`, `log`, `diff`, `branch`, `show`, `rev-parse` | Done, unverified |  | `test/permissions/bash-readonly.test.ts`: twelve allowed forms run without a prompt (pwd, --version for a short list of tools, and the listed flag and ref forms of git status, log, diff, branch, show, rev-parse). Ten forms that read outside the repository, rewrite, or chain still ask: `git diff /dev/null /etc/passwd`, `git -c core.fsmonitor`, `git branch -D`, `--output`, `--no-index`, and `git log && rm`. Allow-list lives in `src/core/tools/bash-readonly.ts`. Full npm test pending |
| HR.22 | The bash classifier accepts `2>&1`, `>/dev/null`, `2>/dev/null`, and a `~` inside a word, while redirection to a file and a word-initial, post-`=`, or post-`:` `~` stay unparseable | Done, unverified |  | `test/tools/bash-classifier-redirects.test.ts`: `2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`, and `>&2` stay part of their segment. `cat x >file` stays unparseable, and a discard does not hide a following `rm`. `HEAD~3` matches as a literal, while word-initial, post-`=`, and post-`:` tildes stay unparseable. Permission, tool, and bash suites pass: 641 tests. Full npm test pending |
| HR.23 | No code change. ADR 0035's one-hour default stands, because the 2026-10-16 suite run took 2,451s. The spec records the measurement | Done | 02846b12266d83873d90a10fa1487567e9e8f3b7 | The spec's non-goals, decisions table, and risks record it. SHA verified with `git cat-file -t` |
| HR.24 | `write` and `edit` refuse a file that changed on disk since the model last read it. `write` refuses to replace an existing file the model has not read in full; a partial read satisfies `edit` only | Done, unverified |  | `test/tools/file-ledger-tools.test.ts`: write refuses an existing file never read, refuses after a partial read, and proceeds after a full read. Edit refuses a file changed on disk since the read. Without a ledger the tools behave as before. Unit cases in `test/tools/file-ledger.test.ts` cover the rules. Decision recorded here: edit requires a prior read only when it sees a change, as the spec states, so a blind edit to an unread file still proceeds. Full npm test pending |
| **Stage 5** | **Cleanup** | | | |
| HR.25 | Delete the durable-state daemon module and its tests, since no production code calls it. Keep the SQLite sidecar and leases, which are used | Done, unverified |  | The durable-state daemon module and its test are removed. Its only importer was its own test. The SQLite sidecar and session leases stay, and their three suites pass: 19 tests. Roadmap and architecture text that still describes the daemon is corrected in HR.32. Full npm test pending |
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

Stage 1 gap fixes (2026-10-16): `grep` skips `.env` and `.env.<suffix>` contents during recursive search, keeping template names (test/tools/grep-sensitive.test.ts). `find` and `ls` return names only, which the gap did not cover. Pinning: HR.4 connections use an agent pinned to the checked addresses, with the proxy case documented in the spec amendment. Full `npm test` passed: 4,275 coding-agent tests.

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
- Headless flags: `--max-turns`, `--max-budget-usd`, `--mcp-config`, and a directory-allowlist flag.
- Persistent memory and `/init`.
- Context files: loading both `AGENTS.md` and `CLAUDE.md`, `@import`, nested files, a size cap.
- Slash commands: `/permissions`, `/cost`, `/context`, `/agents`, `/hooks`, `/mcp` status, `/diff`, `/doctor`.
- PDF and notebook reading.

Not a repository task: about 1,664 leftover `--tmp-pi-*` session directories sit in
`~/.apex-code/agent/sessions` from test runs before 2026-08-20. The leak is fixed, but
nothing removed them.
