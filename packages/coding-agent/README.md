# Apex Code

A provider-agnostic agentic coding harness, forked from Pi. Apex Code combines Pi's
provider and terminal foundations with permissions, OS sandboxing, scalable context,
a broader tool surface, delegation, durable execution, evidence, and cost visibility.

## Install

Apex Code is currently published on npm's prerelease `next` channel and requires
Node.js 22.19 or newer:

```bash
npm install --global apex-code@next
apex-code --version
apex-code
```

Apex Code does not operate a shell installer or standalone binary release channel.
Update it through npm:

```bash
npm install --global apex-code@next
# or, from an existing installation:
apex-code update --self
```

## First run

Configure a model provider interactively with `/login <provider>`, or use
`apex-code auth check --provider <provider>` to verify credentials. Run
`apex-code --help` for flags and `apex-code --mode rpc` for process integration.

Sessions, settings, credentials, extensions, prompts, and other state live under
`~/.apex-code/agent/` by default. Project-local resources live under `.apex-code/`.

## Safety and capabilities

Every tool has a declared contract and passes through the permission gate. Linux and
macOS tool execution can additionally run inside the supported OS sandbox. Windows is
a required build/test portability target, but its sandbox backend remains unsupported.
Built-in capabilities include file/search tools, shell execution, web tools, user
questions, planning, and bounded subagent delegation.

## Network and privacy

Apex Code sends no install or update telemetry to this project. At startup it may make
a single version request to the npm registry for `apex-code@next`; set
`APEX_CODE_SKIP_VERSION_CHECK=1` to disable it. `APEX_CODE_OFFLINE=1` disables startup
network operations. Model requests go to the provider you configure. Optional OTLP
traces are exported only when you explicitly configure your own collector.

Bundled model catalogs work without a hosted catalog. A remote overlay is contacted only
when `APEX_CODE_MODEL_CATALOG_URL` names one. `/share` asks before uploading the complete
HTML session to a secret (unlisted, not private) GitHub Gist; it returns the Gist URL and
adds a preview link only when `APEX_CODE_SHARE_VIEWER_URL` names a viewer.

## Environment compatibility

Canonical runtime controls use the `APEX_CODE_*` prefix, including
`APEX_CODE_OFFLINE`, `APEX_CODE_SKIP_VERSION_CHECK`, `APEX_CODE_PACKAGE_DIR`,
`APEX_CODE_EXPERIMENTAL`, `APEX_CODE_MODEL_CATALOG_URL`, and `APEX_CODE_SHARE_VIEWER_URL`. Temporary `PI_*` aliases
remain for compatibility through the pre-1.0 line and will be removed no earlier than
Apex Code 1.0.0 and 2027-02-16. Canonical values win when both forms are set.

Extension callback variable names, the package manifest `pi` key, and imports from
`@earendil-works/pi-ai` / `@earendil-works/pi-tui` are retained compatibility and
upstream vocabulary, not executable or product branding.

## Documentation

- [`docs/`](docs/) — CLI, extension, provider, theme, and integration reference
- [`containerization.md`](containerization.md) — container usage
- [`CHANGELOG.md`](CHANGELOG.md) — current Apex Code changes and upstream history
- [Source repository](https://github.com/Fchery87/apex-code)

## Support and security

Apex Code is currently maintained by one person on a best-effort basis; see
[the support policy](https://github.com/Fchery87/apex-code/blob/main/docs/support.md) for
response targets, the supported-version line, and platform support. Report vulnerabilities
privately per [`SECURITY.md`](https://github.com/Fchery87/apex-code/blob/main/SECURITY.md).

## Relationship to Pi

Apex Code forks `pi-coding-agent` and `pi-agent-core`, while consuming `pi-ai` and
`pi-tui` as upstream dependencies. Historical Pi links, API vocabulary, and
attribution remain where compatibility requires them.

## License

MIT. See the source repository's `LICENSE` and `NOTICE` files.
