# ADR 0011 — Deferred schemas resolve through an explicit model-callable tool

**Status:** Accepted · **Date:** 2026-08-13

## Decision

Apex Code resolves a deferred tool schema through an explicit, model-callable
`tool_schema` meta-tool. The tool accepts the name of an active tool and returns that
tool's real JSON schema as its tool result. The model must call `tool_schema` before
calling a deferred tool; the schema-load call does not mutate the provider's already
assembled tool list. A subsequent request therefore contains the real schema for the
chosen deferred tool, while tools that were not selected remain announced by name with
an empty-object stub.

The load operation reads the same live active-tool registry used to build the provider
request. Unknown and inactive names are rejected. It never performs external I/O or
workspace mutation, and its own schema is always present (never deferred) so the model
can reach it. Its contract has no capabilities, defaults to `allow`, is not evictable,
and emits no evidence.

## Why this shape

The deferred projection intentionally removes the parameter schema from the static
prefix. Automatic harness-side injection cannot help a model construct a call: when a
deferred tool call arrives, its arguments have already been chosen. An explicit call
creates a visible, testable turn in which the model asks for the schema, receives it,
and then constructs a validated call. This keeps the model-facing behavior honest and
makes the load path usable through the existing tool execution and permission seams.

Returning the schema as a tool result, rather than adding a second hidden provider
request or mutating the in-memory tool list, preserves the agent loop's existing
message ordering and validation behavior. It also means the load tool can remain pure
with respect to the workspace and session state: its result is ordinary transcript
content, and the next request can project the loaded schema from explicit per-session
state.

## Canonical fallback and compatibility

A tool definition without an Apex contract receives `UNCLASSIFIED` from one shared
fallback. Its permission behavior remains conservative (`ask`), its capability set
assumes the worst, its results are not evictable, and it emits no evidence. Foreign and
MCP tools are **not** schema-deferred by this fallback: their real schemas remain
announced, preserving their existing provider-facing behavior and avoiding an
unreachable third-party tool. First-party tools opt into deferral explicitly through
`contract.context.deferSchema`.

The existing context pipeline and permission gate both consume this fallback rather
than deriving separate absent-contract behavior. This prevents contract drift while
preserving compatibility for extensions and MCP tools. The schema-load tool itself is
an additive registry entry; existing tool names, schemas, settings, and session format
remain compatible.

## Consequences

- Every deferred-tool use requires an additional model turn before the real call.
- The model must be able to discover the tool from its retained name and description.
- The loaded schema must be represented in explicit request-local/session state so a
  later request can validate the real call.
- Tool descriptions become operationally important because they are retained while
  schemas are withheld.
- Unclassified foreign tools remain permission-conservative without being made
  unusable by an absent-contract deferral default.

## Rejected alternatives

- **Harness-side injection:** too late to construct the arguments and would hide a
  model-facing operation that affects latency and context.
- **A hidden schema request:** obscures the extra turn, complicates cancellation and
  transcript semantics, and creates a second provider interaction outside the normal
  tool loop.
- **Schema search over tool names:** unnecessary for this phase; the retained names
  and descriptions are the discovery surface. Search/ranking can be added later if a
  measured tool surface needs it.
- **Deferring foreign/MCP tools by default:** breaks third-party tools without a
  guaranteed load caller and changes compatibility for extension authors.
