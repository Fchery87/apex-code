# Public Claude Code and Codex security comparison

Requested cutoff: 2026-09-03. Retrieval: 2026-09-05 UTC.

## Scope and evidence limits

This is a public-document comparison, not a penetration test or verification of either executable. Only official public documentation, Anthropic's public engineering article, and the vendors' public GitHub documentation were read. No local `c-code` source was accessed. No Apex implementation was inspected or changed. The parent reports that the audited Apex checkout itself is dated September 4; this comparison does not establish a September 3 Apex snapshot.

Evidence labels:

- **Live-only:** retrieved on September 5. This proves what the server returned during retrieval, not what was published on September 3. All comparison claims below have this status unless explicitly qualified.
- **Dated publication:** an official article displays a publication date. Its current body can still have changed.
- **Date-pinned:** an immutable public Git commit names the exact document body, and the GitHub API reports a commit timestamp before the cutoff. This is stronger historical evidence, but neither a deployed-binary test nor independent proof of when a release reached every user.

No claim below assigns an installed version to either product. Version numbers appear only where read in official documents. Neither vendor's full September 3 documentation set was recovered. OpenAI's former `/codex/security` URL now redirects to its separate vulnerability-scanning product. The permission/sandbox comparison uses `/codex/sandbox`, which redirects to `learn.chatgpt.com/docs/agent-approvals-security`, instead.

## Main conclusions

1. Both products separate approval decisions from OS-enforced command isolation. Neither a permission prompt nor a model-based approval classifier is an OS boundary. Both have extension and service traffic outside the command sandbox.
2. Current Claude Code docs say the Bash sandbox is off by default. Current Codex docs describe local command sandboxing and network-off as defaults. Do not confuse Claude's `auto` permission mode with its separate sandbox auto-allow mode.
3. Do not describe current Claude Code as universally read-only by default. The current default is plan-, provider-, surface-, version-, and feature-flag-dependent. Do not describe current Codex Linux isolation as simply Landlock. Current docs say bubblewrap plus seccomp, with Landlock compatibility paths.
4. Neither product's command-domain allowlist is a global network policy. MCP, hooks, browser/computer-use tools, hosted services, and model/authentication traffic require separate review.
5. The documents expose useful hardening switches, but defaults and supported policies differ by platform. Treat fallback behavior and trusted extension code as security decisions rather than minor compatibility details.

## Architecture and defaults

| Axis | Claude Code | OpenAI Codex |
| --- | --- | --- |
| Approval boundary | Harness-enforced `allow`, `ask`, and `deny` tool rules. Evaluation order is deny, ask, allow, regardless of specificity. Prompt and `CLAUDE.md` text do not change permissions. [C1] | A command sandbox policy controls technical reach, and `approval_policy` controls when to stop. Rules govern commands requested outside the sandbox. Matching rules choose `forbidden > prompt > allow`. [O1, O3] |
| Default command isolation | `sandbox.enabled` defaults to `false`. Enabling it confines Bash and its child processes, not all tools or the whole client. File tools use permission checks directly. [C2, C9] | Local CLI/IDE command execution uses OS isolation. Network is off by default. Auto uses workspace writes with on-request approvals; docs recommend read-only for folders without version control and note startup may remain read-only until trust. [O1] |
| Default approval mode | Current docs say `auto` for Pro, Max, Team on supported terminal/VS Code sessions. Manual is the built-in mode for `-p`/SDK, Enterprise/API and named third-party provider routes; missing flags, unsupported models, admin restrictions and first-run timing can also select Manual. The documented auto-default minimums are v2.1.228 on macOS/Linux/WSL and v2.1.233 on native Windows. These are live source claims, not inferred release dates. [C8] | Typical Auto is `--sandbox workspace-write --ask-for-approval on-request`. Workspace includes current and temporary directories. Non-version-controlled folders are recommended read-only. Explicit flags avoid relying on onboarding-dependent defaults. [O1] |
| File scope | Sandbox writes default to work directory, session temp and additional directories. Reads default to the rest of the filesystem, including credential files. No built-in credential deny list. `denyRead`, restricted-read settings, credential `deny`/`mask`, and env scrub must be configured where needed. [C2, C9] | Workspace-write protects `.git`, `.agents`, `.codex` within writable roots, including resolved Git directory pointers. Do not interpret workspace-write as a universal read-confidentiality boundary. Beta permission profiles support explicit read/write/deny scopes and minimal runtime paths. [O1, O9] |
| Cloud boundary | Anthropic-hosted web sessions use isolated VMs, restricted network, credential proxy and branch-scoped pushes. Self-hosted execution makes isolation and credentials the deployment's responsibility. Remote Control keeps execution on the local host and adds no VM sandbox. [C3] | Cloud runs in OpenAI-managed containers. Setup can use network and configured secrets; agent phase is offline by default and setup secrets are removed before it. Local CLI/IDE OS isolation is a different boundary. [O1] |

## Approval, escalation, and failure behavior

Claude Code exposes `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`. Manual allows local reads and certain recognized read-only shell commands. Accept Edits also permits edits and selected filesystem commands. Plan is not a claim that no shell command can run. Current docs allow classifier-approved commands when auto is available. `dontAsk` denies tools unless pre-approved. Current bypass mode still has explicit-rule and user-interaction exceptions; it should not be summarized as disabling every safeguard. [C1, C8]

Claude's sandbox modes are independent: auto-allow executes sandboxed commands without ordinary approval; regular-permissions mode keeps permission checks. Explicit deny and command-scoped ask rules still apply. A bare Bash ask is skipped for sandboxed auto-allow commands outside Plan. `dangerouslyDisableSandbox` requests an unsandboxed retry, which returns to regular permissions. In Manual this prompts; in auto it may go to the classifier. `sandbox.allowUnsandboxedCommands=false` disables that retry parameter, but explicitly excluded commands still run outside the sandbox. The default is `true`. `sandbox.failIfUnavailable` defaults to false; a missing dependency or unsupported platform warns and continues without the sandbox unless this hard-failure setting is enabled. [C2, C9]

Codex separates `read-only`, `workspace-write`, and `danger-full-access` from approvals. `on-request`, `untrusted`, and `never` are the documented primary approval policies. `on-failure` is deprecated. `never` is not synonymous with full access: it can retain a read-only or workspace sandbox and refuse escalation. `--dangerously-bypass-approvals-and-sandbox`, alias `--yolo`, removes both. `--full-auto` remains a deprecated compatibility path in current noninteractive examples. Prefix `allow` rules authorize matching commands outside the sandbox without asking; review them as escape permissions, not ordinary in-sandbox allowlists. [O1, O3, O5]

Current Codex docs also offer granular approval categories and opt-in `approvals_reviewer="auto_review"`. The default reviewer is the user. Auto-review examines only actions that already require approval; it does not review every in-sandbox action. The docs report fail-closed review parse/session failures and timeouts. This is another model-mediated decision layer, not a replacement sandbox. [O1]

Codex beta permission profiles combine filesystem and network policies. They do not compose with legacy `sandbox_mode` settings; legacy settings can override profile selection unless managed profile allowlists force profiles. Current managed docs recommend profiles for Codex 0.138.0 or later. Do not give users mixed snippets without checking effective configuration. Unsupported macOS profile enforcement is refused rather than silently unsandboxed; Linux split-policy and Windows carveout support also have explicit refusal cases. [O8, O9]

## OS and network comparison

| Axis | Claude Code | OpenAI Codex |
| --- | --- | --- |
| macOS | Seatbelt. Apple Events blocked by default. Opting into `allowAppleEvents` can start other applications unsandboxed. [C2] | Seatbelt through `sandbox-exec`. Unsupported profile enforcement is refused. [O1, O9] |
| Linux | bubblewrap plus socat proxy relay. Optional seccomp filter adds Unix socket blocking. User-namespace/AppArmor setup affects availability. Weaker nested sandbox mode explicitly reduces security. [C2] | bubblewrap plus seccomp by default; Landlock is available in compatibility paths. User namespaces, kernel/container policy and bwrap support matter. [O1, O9] |
| Windows | Bash sandbox supports WSL2, not native Windows or WSL1. WSL Windows-binary launches depend on Unix socket controls; optional seccomp must exist to block that socket. This is not a claim that Claude Code itself cannot run natively. [C2] | Native elevated and unelevated Windows sandboxes, plus WSL2. Elevated uses dedicated low-privilege users, filesystem permissions and firewall rules. Unelevated uses restricted current-user token/ACLs and weaker environment-based offline controls. Both default to a private desktop. Docs recommend Windows 11; current Windows 10 is best effort. [O1, O2] |
| Domain policy | Proxy-backed `allowedDomains` and deny controls for sandboxed commands. New domains prompt or go to auto classifier. Managed-only domains can block rather than ask. Default proxy does not terminate TLS; experimental TLS termination exists for credential masking, not content filtering. [C2] | Command network is off by default. If enabled, `features.network_proxy=true` is needed to enforce user domain rules. Network on with proxy off is direct unrestricted egress. Admin `experimental_network` can start enforcement separately. Exact/subdomain/apex patterns and deny-first allowlist policy are documented. [O1, O9] |
| Local/private reach | Unix socket allowlists can expose powerful host services; Docker socket effectively grants host access. [C2] | Proxy blocks loopback/private/link-local by default. Exact local exceptions or `allow_local_binding=true` broaden reach. DNS classification is best effort; docs explicitly say rebinding is not eliminated without transport-level IP pinning. [O1] |
| Coverage exclusions | Bash sandbox does not mediate built-in file tools, actual desktop computer use, or all extension/service activity. Subagents share parent configuration, not a distinct OS isolation boundary. [C2] | Command proxy does not filter hosted search, app/connector calls, MCP connections, browser/computer use, cloud tasks, model/authentication traffic. Profiles likewise apply to local commands rather than these surfaces. [O1, O9] |

Codex cached web search remains available independently of command network permission. Cached is the documented local default, with disabled/live/indexed alternatives. Cached results still contain untrusted content. Network-off for commands therefore does not mean the client has no network, and search result domain filtering does not restrict subprocess destinations. [O1, O7, O9]

## Trust, managed configuration, MCP, and hooks

Claude configuration uses managed, CLI, project-local, shared-project and user scopes, highest first, with special security-sensitive exceptions. Many arrays merge rather than replace. Managed locks are needed where policy must not broaden through lower scopes. Current docs warn that `excludedCommands` entries merge and have no managed-only lock. A checked-out configuration file is not equivalent to administrator policy. [C4, C9]

Claude interactive workspace trust holds settings hooks until trust is accepted. Noninteractive `-p` and SDK sessions treat the folder as trusted and can run repository settings hooks without a dialog. Command hooks run with full user permissions. Project `.mcp.json` servers prompt interactively, but `-p`/SDK/cloud load them without asking. Recommended controls include reviewing `.claude` files, `--bare`, disabling hooks, limiting setting sources, and explicit `--strict-mcp-config`. Server connection approval and each tool-call permission are separate questions. [C3, C5, C6]

Claude `PreToolUse` can allow, deny, ask, defer or rewrite a call, but current documentation says hook allow cannot override matching deny/ask rules. Tool and MCP names use canonical permission identifiers. Anthropic does not security-audit or manage arbitrary MCP servers, even when connectors have directory listing review. MCP credentials and server behavior remain separate trust decisions. [C1, C3, C5]

Codex loads project `.codex/` configuration, rules and hooks only for trusted projects. User/system layers still load for an untrusted project. Ordinary CLI/project/profile/user/system precedence applies to defaults, while `requirements.toml` constrains allowed approval policies, profiles/sandbox modes, reviewers, web search, features and MCP servers. An approved MCP name alone is insufficient under a managed allowlist: name and identity must match. Cloud-managed requirements use an identity-matched signed cache and do not silently disappear if fetching fails without a valid cache. [O7, O8]

Codex supports stdio and remote MCP, OAuth/token authentication, `enabled_tools`, `disabled_tools`, and server/per-tool approval modes. Disabled tools apply after enabled tools. Project servers require project trust. Current security docs say destructive app/MCP annotations force approval unless a read annotation takes priority. Treat annotation-driven policy as trust in server-provided metadata, not independent proof that a tool has no side effects. [O1, O4]

Current Codex has lifecycle hooks. Non-managed definitions must be reviewed and trusted by their current hash. Changed hooks are skipped until trusted; managed hooks are trusted by policy. `--dangerously-bypass-hook-trust` exists for externally vetted one-off automation. Concurrent matching hooks all start, so one cannot prevent another hook from starting. MCP hooks use existing connections and do not request tool approval or trigger other hooks; errors or unavailable servers do not block. Some unsupported `PreToolUse` outputs, including `ask`, are reported as failed but the tool continues. A policy ported from Claude must test exact hook semantics. The retrieved Codex hook page does not establish an OS sandbox boundary for command hooks, so no such guarantee is asserted here. [O6]

## Documented tradeoffs and hardening priorities

These are deployment risks described by the sources, not independently reproduced product vulnerabilities. Severity is conditional on the stated threat model. No Apex defect is inferred from this table.

| Priority and classification | Actor/prerequisites | Consequence and source evidence | Narrow remedy |
| --- | --- | --- | --- |
| High, documented tradeoff: optional/fallback Claude sandbox | Prompt-injected shell command, sandbox off or unavailable, host user has sensitive access | Commands run with host reach; `sandbox.enabled=false` and warning fallback are documented. [C2/C9, Sandbox settings] | Enforce enabled + failIfUnavailable; restrict excluded commands and unsandboxed retry. Use an outer boundary for untrusted repositories. |
| High, documented tradeoff: trusted extension code | Malicious repository/configuration and unattended Claude `-p`/SDK, or operator trusts a malicious hook/MCP | Claude full-user hooks and automatic headless project-server load; Codex MCP hook approval bypass and nonblocking errors. [C5/C6, Workspace trust/Project scope; O6, Execution and lifecycle] | Review/disable repository hooks and servers before headless execution. Restrict extension identity, credentials and OS access. Test hook failures. |
| High, documented tradeoff: command allowlist mistaken for global egress control | Attacker controls tool output/repository and can induce MCP/browser/service calls, or Codex network enabled with proxy disabled | Independent service paths do not inherit shell domain rules. Codex domain policy has no effect without active proxy. [C2, Scope; O1/O9, Traffic outside proxy] | Verify effective proxy state and separately govern each service/extension surface. Use lower-layer egress enforcement when required. |
| High, documented limitation: broad files/domains/sockets | Compromised command can read secrets and reach shared allowed host, writable startup file, Docker socket or Apple Events | Exfiltration or later host-context execution remains possible. Claude explicitly documents domain fronting risk under default TLS behavior. Codex documents persistent-write and DNS rebinding risks. [C2, Security limitations; O1/O9] | Minimal reads/writes/hosts, no privileged sockets, keep Apple Events blocked, protect credentials, TLS-aware or lower-layer egress where justified. |
| Medium to high, documented limitation: weaker platform fallback | Windows unelevated mode, Everyone-writable directories, or constrained Linux container namespace support | Reduced network or filesystem guarantees. [O2, Windows troubleshooting; C2/O9, platform enforcement] | Require native elevated Windows where possible, audit ACLs, or use a controlled VM/WSL2/container boundary; reject unsupported mandatory policies. |
| Medium, documented compatibility risk: approval/hooks/config drift | Administrator copies old examples or Claude hook schema into current Codex | Incorrect assumptions about default mode, approval bypass, legacy/profile precedence or error behavior. [C8, O3/O5/O6/O9] | Pin tested client versions and config schemas. Test allowed, denied, malformed, missing-dependency and escalation paths at the public boundary. |

Positive controls worth comparing with Apex: explicit denial precedence; OS child-process enforcement; protected configuration paths; read restrictions separate from write scopes; network-off defaults or explicit managed egress; visible escalation; hard-failure switches; project trust; managed extension identities; hook change trust; approval trace/audit output. Documentation coverage alone does not prove correct wiring in any implementation.

## What can be anchored before September 4

- **Claude date-pinned document:** GitHub API query D1 returned commit `b3f0e501b79fe5cfc8c10d18cf3b0b6715c5c2fb`, committer timestamp `2026-09-03T23:48:05Z`. D2 is its immutable public `CHANGELOG.md`, headed `2.1.260`. It records `sandbox.failIfUnavailable` in 2.1.83 and subprocess credential scrubbing for Bash/hooks/MCP stdio in that section. Its 2.1.260 section records fixes for file permission paths with parentheses being ignored by the Bash sandbox, zsh assignment command-substitution auto-approval, and managed settings not loading with a leftover API key. These support the existence of published change descriptions by the cutoff. They do not prove any older/newer installed binary is safe.
- **Claude dated publication:** D3 displays October 20, 2025 and describes filesystem + network isolation, bubblewrap/Seatbelt, Unix-socket proxy routing, and the optional `/sandbox` workflow. Its then-described read-only default must not replace the live plan-dependent default. Its broad claim that successful prompt injection is fully isolated should not override the current explicit security limitations.
- **Codex date-pinned historical document:** D4 shows the January 2, 2026 commit replacing local user docs with links to developer docs. D5 verifies its parent `2de731490e86c11980c1c90b8a9f3fe332a118fd` at `2026-01-02T19:30:04Z`. D6 is that parent's immutable `docs/sandbox.md`. It describes read-only-until-trust, workspace-write + on-request, network disabled by default, macOS Seatbelt, Linux Landlock + seccomp, and experimental Windows restricted-token/environment-offline enforcement. This is historical January documentation, **not** verified September 3 behavior. The difference from September 5 docs is why a timeless Landlock-only or experimental-Windows comparison would mislead.
- The official OpenAI Introducing Codex article request returned HTTP 403. Its body was not used. No archived September 3 OpenAI docs snapshot was obtained. There is no date-verifiable basis here for asserting every current profile, proxy, native Windows, auto-review or hook feature was available on September 3.

## Source register and retrieval evidence

All cited pages were read. Whitespace in short excerpts below is normalized. HTTP `Date` and `Last-Modified` are response metadata, not proof of original publication time. Each entry includes the SHA-256 of the retrieved response body for identification; raw HTML was not added to the repository. The actual check was a public HTTP GET via `httpx.AsyncClient(follow_redirects=True, timeout=30)`, followed by HTML text extraction with BeautifulSoup. No vendor CLI tests or Apex tests were run by this worker.

### C1: claude_permissions

Requested: https://code.claude.com/docs/en/permissions

Final: https://code.claude.com/docs/en/permissions

GET status `200`; fetched `2026-09-05T01:19:20.580512+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:20 GMT`; Last-Modified `absent`.

Response SHA-256: `68a46c3170c1146a646ab936cdd42879f023d27ba3d187f9a35daa4cf45d09cf`.

> Rules are evaluated in order: deny, then ask, then allow.
> Permission rules are enforced by Claude Code, not by the model.
> Hook decisions don’t bypass permission rules.

### C2: claude_sandbox

Requested: https://code.claude.com/docs/en/sandboxing

Final: https://code.claude.com/docs/en/sandboxing

GET status `200`; fetched `2026-09-05T01:19:35.116134+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:33 GMT`; Last-Modified `absent`.

Response SHA-256: `020b7793ba09eff21fa87f738269d3c74aadacf7b75e4a1f3b80edb05a75356a`.

> Native Windows is not supported.
> By default, if the sandbox cannot start because dependencies are missing or the platform is unsupported, Claude Code shows a warning and runs commands without sandboxing.
> There is no built-in credential deny list, so only the files and variables you list are restricted.
> The sandbox isolates Bash subprocesses.

### C3: claude_security

Requested: https://code.claude.com/docs/en/security

Final: https://code.claude.com/docs/en/security

GET status `200`; fetched `2026-09-05T01:19:35.019049+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:33 GMT`; Last-Modified `absent`.

Response SHA-256: `098ca72ad116423db9b85a21befddefaf9179f9a79a6394a04abec208b5df7c2`.

> Trust verification is disabled when running non-interactively with the -p flag
> Anthropic reviews connectors against its

### C4: claude_settings

Requested: https://code.claude.com/docs/en/settings

Final: https://code.claude.com/docs/en/settings

GET status `200`; fetched `2026-09-05T01:19:34.860779+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:33 GMT`; Last-Modified `absent`.

Response SHA-256: `a28c8c14e9be9d536bc04e31502cfc2291b62a0e4e537fb8fb25656eaafc6f69`.

> Lists merge instead of overriding

### C5: claude_hooks

Requested: https://code.claude.com/docs/en/hooks

Final: https://code.claude.com/docs/en/hooks

GET status `200`; fetched `2026-09-05T01:19:35.716397+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:33 GMT`; Last-Modified `absent`.

Response SHA-256: `a2d5c45fcb10558c41c95db54608adfac0104badae0e5fc061d459c9e812a420`.

> Command hooks execute shell commands with your full user permissions.
> Claude Code never shows the dialog and treats the folder as trusted, so hooks committed in a repository’s

### C6: claude_mcp

Requested: https://code.claude.com/docs/en/mcp

Final: https://code.claude.com/docs/en/mcp

GET status `200`; fetched `2026-09-05T01:19:35.410558+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:33 GMT`; Last-Modified `absent`.

Response SHA-256: `d7b403524e022223c64acaac127150868dc44fb01fde4c49038ec6b5f60b5ed6`.

> it loads project-scoped servers without asking.

### C8: claude_modes

Requested: https://code.claude.com/docs/en/permission-modes

Final: https://code.claude.com/docs/en/permission-modes

GET status `200`; fetched `2026-09-05T01:20:59.299474+00:00`; HTTP Date `Sat, 05 Sep 2026 01:20:59 GMT`; Last-Modified `absent`.

Response SHA-256: `cec31df639c0493eab15d29c5180caad7fc42a418f8143a429ced4d78fc8c74d`.

> On Pro, Max, and Team plans, the built-in starting permission mode is auto mode.
> The built-in auto default requires Claude Code v2.1.228

### C9: claude_setting_ref

Requested: https://code.claude.com/docs/en/settings-reference

Final: https://code.claude.com/docs/en/settings-reference

GET status `200`; fetched `2026-09-05T01:23:08.721471+00:00`; HTTP Date `Sat, 05 Sep 2026 01:23:08 GMT`; Last-Modified `absent`.

Response SHA-256: `84499ff56e5341bb9192e7b46c97ee713f9277621339aeb784c7fab5b1f7cd2b`.

> Default : false
> can read the rest of the filesystem, including credential files.

### O1: codex_sandbox

Requested: https://developers.openai.com/codex/sandbox

Final: https://learn.chatgpt.com/docs/agent-approvals-security

GET status `200`; fetched `2026-09-05T01:19:36.070627+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:35 GMT`; Last-Modified `Fri, 04 Sep 2026 23:41:49 GMT`.

Response SHA-256: `a13ef10dd8306d2acacc67b588bf2a09aab51244f4987f8f7dad65b9fba0a249`.

> By default, the agent runs with network access turned off.
> Network on + network_proxy off: network stays on with unrestricted direct outbound access.
> The check reduces DNS rebinding risk, but it does not eliminate it.
> It does not filter web search, app or connector tool calls, MCP server connections

### O2: codex_windows

Requested: https://developers.openai.com/codex/windows

Final: https://learn.chatgpt.com/docs/windows/windows-sandbox

GET status `200`; fetched `2026-09-05T01:19:36.163279+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:36 GMT`; Last-Modified `Fri, 04 Sep 2026 23:39:01 GMT`.

Response SHA-256: `314ffe225ddcede9b2057b32756d9451dceb5b6af56639e0bd61aaedcfe241ac`.

> It's weaker than elevated
> By default, both sandbox modes also use a private desktop for stronger UI isolation.

### O3: codex_rules

Requested: https://developers.openai.com/codex/rules

Final: https://learn.chatgpt.com/docs/agent-configuration/rules

GET status `200`; fetched `2026-09-05T01:19:36.225487+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:36 GMT`; Last-Modified `Fri, 04 Sep 2026 23:38:31 GMT`.

Response SHA-256: `b0e8a2d0b6d9d77fe1d8a48875e65f280774a0d76c18fd9481a2d957747404fc`.

> forbidden > prompt > allow

### O4: codex_mcp

Requested: https://developers.openai.com/codex/mcp

Final: https://learn.chatgpt.com/docs/extend/mcp?surface=cli

GET status `200`; fetched `2026-09-05T01:19:36.187136+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:36 GMT`; Last-Modified `Fri, 04 Sep 2026 23:39:18 GMT`.

Response SHA-256: `d75c6f480c6e2b868fe24f732d0e77a3bc6bcd30dd32bc3034891eb97e62e30a`.

> .codex/config.toml (trusted projects only).
> disabled_tools (optional): Tool deny list (applied after enabled_tools ).

### O5: codex_config

Requested: https://developers.openai.com/codex/config-reference

Final: https://learn.chatgpt.com/docs/config-file/config-reference

GET status `200`; fetched `2026-09-05T01:19:36.247485+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:36 GMT`; Last-Modified `Fri, 04 Sep 2026 23:37:36 GMT`.

Response SHA-256: `10b14fa945f2c55d7ef50441b6740c70fa5367a6d63b807bfd5dee8e379f57e8`.

> on-failure is deprecated

### O6: codex_hooks

Requested: https://developers.openai.com/codex/hooks

Final: https://learn.chatgpt.com/docs/hooks

GET status `200`; fetched `2026-09-05T01:20:59.381296+00:00`; HTTP Date `Sat, 05 Sep 2026 01:20:59 GMT`; Last-Modified `Fri, 04 Sep 2026 23:38:01 GMT`.

Response SHA-256: `288395dce53d51616585c7d41d2fc5f168a03702c3562fd9796c867166d7ef17`.

> Codex records trust against the hook's current hash
> Errors, missing servers, and unavailable tools don't block the operation.
> MCP tool hooks run synchronously. They don't request tool approval or trigger other hooks.

### O7: codex_basics

Requested: https://developers.openai.com/codex/config-file/config-basic

Final: https://learn.chatgpt.com/docs/config-file/config-basic

GET status `200`; fetched `2026-09-05T01:20:59.361564+00:00`; HTTP Date `Sat, 05 Sep 2026 01:20:59 GMT`; Last-Modified `Fri, 04 Sep 2026 23:38:38 GMT`.

Response SHA-256: `6ecadbfb6962f7246bb90e319b3ff7b2a48a21931ff12b397415ef1a5e2327e2`.

> For security, Codex loads project .codex/ layers only when you trust the project.

### O8: codex_managed

Requested: https://developers.openai.com/codex/enterprise/managed-configuration

Final: https://learn.chatgpt.com/docs/enterprise/managed-configuration

GET status `200`; fetched `2026-09-05T01:20:59.376815+00:00`; HTTP Date `Sat, 05 Sep 2026 01:20:59 GMT`; Last-Modified `Fri, 04 Sep 2026 23:42:58 GMT`.

Response SHA-256: `bf722c8af96072acad3434004931b470b4aab2e78f6a709c6083daf3dd49a122`.

> Requirements constrain security-sensitive settings
> its name and identity match an approved entry

### O9: codex_profiles

Requested: https://developers.openai.com/codex/permissions

Final: https://learn.chatgpt.com/docs/permissions

GET status `200`; fetched `2026-09-05T01:23:09.037709+00:00`; HTTP Date `Sat, 05 Sep 2026 01:23:08 GMT`; Last-Modified `Fri, 04 Sep 2026 23:42:59 GMT`.

Response SHA-256: `c695a8256021b982ef5fd4a2a0c3d621afcfe655e88b1abd4b6271de645fe0aa`.

> Beta. Permission profiles are under active development and may change.
> with Landlock available for compatibility fallback paths.

### D1: claude_dated_api

Requested: https://api.github.com/repos/anthropics/claude-code/commits?path=CHANGELOG.md&until=2026-09-03T23%3A59%3A59Z&per_page=1

Final: https://api.github.com/repos/anthropics/claude-code/commits?path=CHANGELOG.md&until=2026-09-03T23%3A59%3A59Z&per_page=1

GET status `200`; fetched `2026-09-05T01:21:34.059139+00:00`; HTTP Date `Sat, 05 Sep 2026 01:21:34 GMT`; Last-Modified `Thu, 03 Sep 2026 23:48:05 GMT`.

Response SHA-256: `7531b88f14c474e4bbce30abf4e1717dc7006957e612cfff723c1cca4ee9dcb5`.

> "date":"2026-09-03T23:48:05Z"

### D2: claude_pinned_changelog

Requested: https://raw.githubusercontent.com/anthropics/claude-code/b3f0e501b79fe5cfc8c10d18cf3b0b6715c5c2fb/CHANGELOG.md

Final: https://raw.githubusercontent.com/anthropics/claude-code/b3f0e501b79fe5cfc8c10d18cf3b0b6715c5c2fb/CHANGELOG.md

GET status `200`; fetched `2026-09-05T01:22:04.146944+00:00`; HTTP Date `Sat, 05 Sep 2026 01:22:04 GMT`; Last-Modified `absent`.

Response SHA-256: `5f1267e095f1839d2f6f83ec293a4525412782025f9ff9b204fe55228b7636c9`.

> ## 2.1.260
> Added `sandbox.failIfUnavailable` setting to exit with an error when sandbox is enabled but cannot start, instead of running unsandboxed

### D3: anthropic_dated

Requested: https://www.anthropic.com/engineering/claude-code-sandboxing

Final: https://www.anthropic.com/engineering/claude-code-sandboxing

GET status `200`; fetched `2026-09-05T01:20:59.404458+00:00`; HTTP Date `Sat, 05 Sep 2026 01:20:59 GMT`; Last-Modified `absent`.

Response SHA-256: `0f1fb6cb10793bad14d4df1b3c08ed7f1ab4ca248e62895139cd4ec22bf310a3`.

> Oct 20, 2025
> Linux bubblewrap and MacOS seatbelt

### D4: codex_history

Requested: https://api.github.com/repos/openai/codex/commits?path=docs/sandbox.md&until=2026-09-03T23%3A59%3A59Z&per_page=1

Final: https://api.github.com/repos/openai/codex/commits?path=docs/sandbox.md&until=2026-09-03T23%3A59%3A59Z&per_page=1

GET status `200`; fetched `2026-09-05T01:21:34.135442+00:00`; HTTP Date `Sat, 05 Sep 2026 01:21:34 GMT`; Last-Modified `Fri, 02 Jan 2026 20:01:53 GMT`.

Response SHA-256: `53419d275567e097789704b10901c1b15dc7a930e1e5d524ed7ed28751da75cb`.

> Replaced user documentation with links to developers docs site

### D5: codex_pinned_parent

Requested: https://api.github.com/repos/openai/codex/commits/2de731490e86c11980c1c90b8a9f3fe332a118fd

Final: https://api.github.com/repos/openai/codex/commits/2de731490e86c11980c1c90b8a9f3fe332a118fd

GET status `200`; fetched `2026-09-05T01:22:04.159902+00:00`; HTTP Date `Sat, 05 Sep 2026 01:22:04 GMT`; Last-Modified `Fri, 02 Jan 2026 19:30:04 GMT`.

Response SHA-256: `d7bdf57ef523fa5709ac63dc83f0de860d03c79b7f3c50e395f77b804a300a8b`.

> 2026-01-02T19:30:04Z

### D6: codex_pinned_sandbox

Requested: https://raw.githubusercontent.com/openai/codex/2de731490e86c11980c1c90b8a9f3fe332a118fd/docs/sandbox.md

Final: https://raw.githubusercontent.com/openai/codex/2de731490e86c11980c1c90b8a9f3fe332a118fd/docs/sandbox.md

GET status `200`; fetched `2026-09-05T01:22:04.110610+00:00`; HTTP Date `Sat, 05 Sep 2026 01:22:04 GMT`; Last-Modified `absent`.

Response SHA-256: `4218f15692931c63ed99d1aede50ef7f5f3858ee251894378118cc0e7a8d51b2`.

> Combines **Landlock** and **seccomp** APIs
> Windows sandbox support remains experimental.

### X1: codex_security

Requested: https://developers.openai.com/codex/security

Final: https://learn.chatgpt.com/docs/security

GET status `200`; fetched `2026-09-05T01:19:36.151405+00:00`; HTTP Date `Sat, 05 Sep 2026 01:19:36 GMT`; Last-Modified `Fri, 04 Sep 2026 23:46:16 GMT`.

Response SHA-256: `b41c03366d3dadfbefa8188b7a2b27c56eb529925890f9269d68a56a1d70711d`.

> Codex Security is an application security agent

### X2: openai_dated

Requested: https://openai.com/index/introducing-codex/

Final: https://openai.com/index/introducing-codex/

GET status `403`; fetched `2026-09-05T01:20:59.297980+00:00`; HTTP Date `Sat, 05 Sep 2026 01:20:59 GMT`; Last-Modified `absent`.

Response SHA-256: `5f1517c19a5dd78b21ee269754aec63e2018ce834d7450ee0659ad9236066841`.

No supporting body excerpt used.

Machine-readable HTTP log: `public-comparison-fetches.json`. Extracted source text and immutable changelog/doc bodies: `public-comparison-extracts.json`. These are public-source evidence artifacts only.
