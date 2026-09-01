# Plan: ACP adapter (spec 2026-08-31-acp-adapter.md)

**Status:** In progress -- opened 2026-08-31

Task numbers are identifiers, not a sequence. A task is **done** only when its
check has actually run and passed.

| Task | State | Commit SHA |
| --- | --- | --- |
| ACP.1 -- `modes/acp/translate.ts`: session/json events -> `session/update` variants, stop reasons, tool kinds | **done** -- verified by `test/acp/translate.test.ts` (5/5) | -- (this commit) |
| ACP.2 -- `modes/acp/server.ts`: JSONL JSON-RPC dispatch (initialize, session/new+load, prompt, set_mode, cancel) with request_permission bridge | **done** -- verified by `test/acp/server.test.ts` (8/8) | -- (this commit) |
| ACP.3 -- Permission responder bridge: `AgentSessionConfig.permissionResponderFactory` + ACP-backed responder | **done** -- verified by the permission-bridge tests in `test/acp/server.test.ts` | -- (this commit) |
| ACP.4 -- Mode dispatch: `--mode acp` in `cli/args.ts` + `main.ts`, stdout guard | **done** -- verified by tsgo + the compile-time dispatch typing; real-provider turn verified manually | -- (this commit) |
| ACP.5 -- Gates (tsgo, biome, targeted vitest, full `npm test`), commit, CI, land | **in progress** -- tsgo clean, biome clean, check:docs passed, full `npm test` exit 0 (3,177/58 across 377 files); commit + CI pending | -- |

| ACP.1 -- `modes/acp/translate.ts`: session/json events -> `session/update` variants, stop reasons, tool kinds | **done** -- verified by `test/acp/translate.test.ts` (5/5) | -- (this commit) |
| ACP.2 -- `modes/acp/server.ts`: JSONL JSON-RPC dispatch (initialize, session/new+load, prompt, set_mode, cancel) with request_permission bridge | **done** -- verified by `test/acp/server.test.ts` (8/8) | -- (this commit) |
| ACP.3 -- Permission responder bridge: `AgentSessionConfig.permissionResponderFactory` + ACP-backed responder | **done** -- verified by the permission-bridge tests in `test/acp/server.test.ts` | -- (this commit) |
| ACP.4 -- Mode dispatch: `--mode acp` in `cli/args.ts` + `main.ts`, stdout guard | **done** -- verified by tsgo + the compile-time dispatch typing; real-provider turn verified manually | -- (this commit) |
| ACP.5 -- Gates (tsgo, biome, targeted vitest, full `npm test`), commit, CI, land | **in progress** -- tsgo clean, biome clean, check:docs passed, full `npm test` exit 0 (3,177/58 across 377 files); commit + CI pending | -- |

## Decisions taken during execution

- **`session/load` reattaches without history replay in v1**: the ACP v1 contract streams prior entries back before responding; Apex v1 responds `null` after reattaching, so the client continues from a clean transcript view. Full replay needs a message-to-chunk mapping across every historical entry kind and is deferred.
- **ACPInput source**: `InputSource` gains `"acp"` so prompts record their origin instead of masquerading as rpc.
- **Extensions see ACP as a headless rpc-like mode** (`cli/project-trust.ts` maps `"acp"` -> `"rpc"` for `ExtensionMode`) -- no ACP-specific extension surface exists yet.
- **`PermissionSpec`/gate untouched**: the ACP responder bridges through `PermissionResponder.ask` and returns `{allow, persist}`; rule persistence stays in the gate (ADR 0010), and `allow_always` persists the same session-scope rule the TUI's "always allow" writes.

## Verification

Translation unit tests pin the emitted `session/update` shapes; server tests
drive dispatch over in-memory JSONL streams with a scripted fake session; an
integration test runs the server against a real `createAgentSession` for
initialize/session lifecycle (real-provider prompt turns are verified manually
before landing). At closure: `npx tsgo --noEmit`, `biome check`,
`npm run check:docs`, and the full `npm test` (both workspaces) as the final
gate.
