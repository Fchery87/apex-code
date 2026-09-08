# Bash arguments survive provider conversion

**Status:** Active

## Problem

The background-shell change made the `bash` parameter schema a root `anyOf`
union. The Anthropic adapter in the consumed `pi-ai` dependency copies root
`properties` and `required` into its nonstrict tool declaration. The union has
neither field, so the provider receives an empty object schema. A model call
with `{}` then fails local validation before shell execution.

The failure was reproduced with the real Anthropic request builder. Its
`onPayload` callback captured this declaration before any network request:

```json
{"type":"object","properties":{},"required":[]}
```

## Design

Keep one `bash` tool and its existing command, retrieve, and terminate call
forms. Expose `command`, `timeout`, `background`, `handle`, and `kill` as root
object properties so the provider receives their types and descriptions.
Derive those properties from the same field schemas used by the alternatives.

Retain the alternatives in the local schema and preserve the inferred
`BashToolInput` union. Empty calls must fail before permission evaluation.
Describe when a model must supply a command or a background handle because
the nonstrict Anthropic adapter omits cross-field constraints.

This change belongs in Apex's tool declaration. It does not patch or fork
`pi-ai`, change permission classification, introduce a tool, or alter session
data. Existing overlap between union branches is outside this compatibility
fix. The schema change also applies to the PowerShell tool, which shares this
declaration.

## Verification

Add a regression test that captures the actual Anthropic request before
network I/O. It must fail against the old schema and pass when all five
properties reach the provider. Check normal and experimental sampling paths.

Exercise local argument validation for command execution, background launch,
retrieval, and termination. Prove that an empty call cannot reach the agent's
permission hook. Run the existing background-shell tests to verify real
execution, output retrieval, and process termination in temporary directories.

Run the TypeScript check, repository checks, and full test suite. Rebuild the
local CLI and inspect the compiled tool's outgoing request before claiming the
installed launcher uses the fix. Store command output under `.apex-code/`.

## Deletion inventory

Replace the union-only `bash` declaration. No module, dependency, tool name,
configuration field, or session format becomes obsolete.
