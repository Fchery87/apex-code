# Spec: A localhost browser tool

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-22 |
| Last updated | 2026-10-22 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. The tool is absent from the default tool list. Sessions that do not opt in keep the same tool names and the same prompt prefix. `web_fetch` keeps refusing loopback unless `webFetch.allowPrivateNetwork` is set. |

## Executive summary

Apex Code can fetch a public URL as text. It cannot open the app the user is building, read that page's console, or return a screenshot. This spec adds one tool, `browser`, that does those three things for a loopback URL. The tool is not registered until the user opts in. A URL that is not loopback is refused before any browser starts. Desktop control of other apps is out of scope.

## Context and motivation

- `docs/research/2026-10-22-coding-agent-cli-gap.md` ranks this fifth. It says the tool opens a localhost URL, reads the console, and returns a screenshot. It says the first version stays on loopback addresses, asks before any other origin, and stays out of the default tool list. It declines desktop control of every app.
- `packages/coding-agent/src/core/tools/web-fetch.ts` already classifies loopback, private, and link-local addresses, and refuses them unless `webFetch.allowPrivateNetwork` is set. `browser` is the tool that is allowed to open loopback. `web_fetch` does not gain that permission.
- `docs/architecture/contracts.md` § 1 and ADR 0010 require every tool to declare capabilities, permission, context, and evidence. `lsp` is the existing pattern for a tool that is registered only when configured, so an unconfigured session's tool list and prompt prefix stay unchanged.
- `docs/adr/0013-no-unowned-hosted-service-defaults.md` forbids a default dependency on a hosted service Apex Code does not run. The browser is a local process. It does not call a hosted browser service.

## Current state

`web_fetch` returns text for an http or https URL. It refuses a host that resolves to a loopback, private, or link-local address unless the user has set `webFetch.allowPrivateNetwork`. It does not run JavaScript, read a console, or return an image.

No tool in `packages/coding-agent/src/core/tools/` launches a browser. The default registry in `createAllToolDefinitions` includes `web_fetch` and `web_search` unconditionally, and includes `lsp` and `mcp` only when their options are set.

## The problem

A UI change has no check the agent can run. `web_fetch` returns the server's HTML and refuses `http://127.0.0.1` by default. A page that renders in the browser, logs an error, or fails only after JavaScript runs is invisible to the session. The user has to look at the page and type what they saw.

## Goals

- [ ] `browser` is a tool with a required contract. It is registered only when the user opts in. With no opt-in, the tool list and the static prompt prefix are unchanged.
- [ ] A call names one absolute `http` or `https` URL. The host must be a loopback name or address: `localhost`, `127.0.0.1`, or `::1`. Any other host is refused before a browser process starts.
- [ ] A refused call returns the reason as tool text. It does not ask the user to approve a non-loopback origin. Approval for other origins is later work.
- [ ] A successful call returns the page title, the console messages captured while the page loaded, and one screenshot. Console text and the screenshot are both capped.
- [ ] The tool does not click, type, navigate a second time, run arbitrary script, or read a file the page did not render. One call opens one URL and returns.
- [ ] The browser process is started by this tool and stopped when the call ends, including when the call is aborted or times out.
- [ ] Tests drive the tool through an injected browser. They do not launch a real browser and they do not listen on a network port.

## Non-goals

- [ ] Desktop control, attaching to the user's already-open browser, or driving apps other than the page at the given URL.
- [ ] Origins that are not loopback, including private LAN addresses and public hosts. `web_fetch` remains the tool for public URLs.
- [ ] Changing `web_fetch` so that it allows loopback. The two tools stay separate.
- [ ] Multi-step browsing, login flows, file downloads, or a persistent browser profile.
- [ ] A hosted browser service, a browser vendor SDK as a required dependency, or a browser binary shipped inside the npm package.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Destination check | A pure function. Accept `http` and `https` URLs whose host is `localhost`, `127.0.0.1`, or `::1`. Reject every other scheme and host, including DNS names that might resolve to loopback. | `packages/coding-agent/src/core/tools/browser-destination.ts` |
| Tool | `createBrowserToolDefinition` takes an injected browser operation. The default operation is absent in this spec's first slice. The contract, the destination check, and the result assembly are testable without it. | `packages/coding-agent/src/core/tools/browser.ts` |
| Contract | Capabilities `{net}`. Default permission behavior `ask`. `matches` compares the URL's host and path with a glob, the same shape `web_fetch` uses. `resultRecoverable` is false, because a console and a screenshot are a moment in a running app. `deferSchema` is true. Evidence emits nothing. | same file |
| Result | Text content carries the title, the final URL, and the capped console. One image content block carries the screenshot when the operation returned one. Missing screenshot is reported as text, not as a failed tool call, when the page itself loaded. | same file |
| Opt-in | `ToolsOptions.browser` is optional. `createAllToolDefinitions` and `createAllTools` add `browser` only when it is set, following `lsp`. Wiring that option from a setting is a later task in the plan. | `packages/coding-agent/src/core/tools/index.ts` |

The first implementation slice stops at the tool definition, the destination check, and tests with an injected operation. Launching a real browser is a later task, because it needs a browser binary the repo does not ship and a decision about which local binary to run.

## Deletion inventory

Nothing existing is removed. `web_fetch` keeps its private-network refusal. No default tool is renamed or dropped.

## Risks

A loopback name is not the same as a loopback address. `localhost` can resolve to something else on a hostile resolver. This spec accepts the three literal hosts and does not resolve DNS. A later slice that launches a real browser must connect only to those hosts and must not follow a redirect to any other host.

A screenshot of a local app can contain secrets the user did not mean to send to the model. The tool is opt-in and asks by default, and the screenshot is one capped image. The spec does not try to redact page content.

An injected operation that ignores the destination check would make the unit tests pass while a real browser loaded another origin. The tool checks the URL before it calls the operation, and a test covers that order.

## Verification

- A unit test accepts `http://127.0.0.1:3000/`, `http://localhost/path`, and `https://[::1]/`.
- A unit test rejects `http://example.com/`, `http://10.0.0.1/`, `file:///tmp/x`, and `http://127.0.0.1.example.com/`.
- A tool test with an injected operation returns the title, console text, and an image block for an allowed URL.
- A tool test for a rejected URL returns the refusal and does not call the operation.
- A registry test shows `browser` absent from `createAllToolDefinitions` when `options.browser` is unset, and present when it is set.

No roadmap phase gate applies. This is a product-surface follow-up.

## Rollout

Needs `docs/plans/2026-10-22-localhost-browser.md`. The destination check, the tool definition, and the registry opt-in should land as separate commits. A real browser process is not part of the first plan.

No ADR. The tool uses the existing contract, the existing permission gate, and no hosted service.
