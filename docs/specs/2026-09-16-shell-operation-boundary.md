# Spec: One parsed shell operation, shared by every consumer

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-09-16 |
| Last updated | 2026-09-16 |
| Roadmap phase | none (security follow-up to `docs/specs/2026-08-31-background-shell.md`) |
| Tracking issue/PR | none |
| Compatibility posture | Restricts compatibility — previously accepted ambiguous calls are now rejected |

**Compatibility posture:** restricting. The advertised schema is unchanged, so
what a provider sees and what a model may emit are byte-for-byte identical. What
changes is which emitted combinations the tool accepts: a call naming two
operations at once, or naming none, is now rejected instead of being silently
dispatched to whichever operation the reading consumer happened to prefer. No
settings key is introduced and the session format is untouched.

## Executive summary

The shell schema advertises a flat bag of fields — `command`, `timeout`,
`background`, `handle`, `kill` — because providers ignore `anyOf` (`toolUnion`,
`contract.ts`). That bag is advertisement, not enforcement, and models routinely
populate every field of it. Four consumers each re-read the raw bag and answered
"which operation is this?" differently. Permissions keyed on `command` being
present; execution keyed on `handle` being present; evidence and display keyed on
`command` again.

A call carrying both therefore authorized as one operation and performed another.
With `pwd` allowed and `background-handle` denied, `{command: "pwd", handle, kill:
true}` turned `block: true` into `block: false` and the kill ran, while the
evidence ledger recorded `pwd` — a command that never executed.

This adds one parse at the boundary, `parseShellOperation`, producing an exclusive
`ShellOperation`. Permissions, execution, preview, display, and evidence all read
that one answer.

## Context and motivation

- `docs/adr/0010-one-canonical-tool-contract.md` settles this exact principle one
  level up: a classification derived once for authorization and separately
  re-derived for the surfaces that describe it drifts, "until the two disagreed and
  a real registered tool fell through both classifiers into neither." ADR 0010
  binds the *tool*'s classification. Nothing bound the *call*'s operation, and the
  same drift reappeared inside a single tool.
- `docs/specs/2026-08-31-background-shell.md` added the handle-based retrieve and
  kill shapes. It specified three call shapes but left each consumer to recognize
  them independently, which is where the disagreement entered.
- `docs/adr/0004-permission-rule-model.md` — the permission engine holds no
  tool-specific matching, so the tool alone can close this.

## The operation model

```ts
type ShellOperation =
  | { kind: "run"; command: string; timeout: number | undefined; background: boolean }
  | { kind: "retrieve"; handle: string }
  | { kind: "kill"; handle: string };
```

`parseShellOperation(params)` returns either that operation or a reason string.
It is the only place the raw argument bag is interpreted.

### Placeholder policy, stated once

Models populate advertised fields they do not mean to use. The recorded failure
that prompted this work sent `handle: ""` alongside a real command in all 18 calls
of one session. The policy is now explicit and applied in exactly one place:

- A value that is absent, `null`, or an empty string carries no request and is
  dropped.
- A value that would change behavior if honored is never dropped. It either
  selects the operation, or — when it belongs to a different operation — makes the
  call ambiguous and the call is rejected.

### Rejected combinations

| Call | Outcome |
| --- | --- |
| `command` and a non-empty `handle` | Rejected. Two operations named. |
| `kill: true` with `command` and no handle | Rejected. `kill` terminates a background command and needs its handle. |
| `timeout` or `background: true` with a handle | Rejected. Fields of a different operation. |
| `handle: ""` alone | Rejected, naming the empty handle. |
| Neither `command` nor `handle` | Rejected, naming both ways forward. |

Rejection is fail-closed at the gate as well as at execution. An unparseable call
returns `true` from `isUnknown`, which by `rules.ts` can never be matched by an
allow rule and is matched by every deny rule.

## Deletion inventory

No file or exported symbol is removed. What is deleted is the nine independent
`"command" in params` / `"handle" in input` discriminator sites in `bash.ts`, each
of which was its own classification of the call. They are replaced by calls to the
single parse. The advertised schema, `toolUnion`, the background registry, and the
foreground execution path are untouched.

`bashSchema`'s three union variants remain the provider-facing description of the
valid shapes. They are no longer load-bearing for enforcement, and tightening them
(for example `anyOf` to `oneOf`) would still not be, because providers drop union
constraints — which is why enforcement is local.

## Non-goals

- **PowerShell permission grammar.** `powershell.ts` shares the Bash permission
  spec, whose tokenizer treats backslash as an escape character. PowerShell does
  not. That is a separate defect with a separate fix.
- **Timeout semantics for background launches.** Background launch ignores
  `timeout` by design (`2026-08-31-background-shell.md`), but the schema and the
  renderer still advertise it unconditionally. Making that restriction explicit is
  a contract change, not part of the operation boundary.
- **PowerShell's unsupported background operations.** Its default adapter
  implements only `exec` while the shared schema advertises the background
  lifecycle.

## Risks

A model that habitually sends placeholder fields now receives a rejection where it
previously received either a confusing "Unknown background handle: ." error or a
silently mis-dispatched operation. The rejection names the conflict and both ways
forward, which is strictly more recoverable than the error it replaces.
