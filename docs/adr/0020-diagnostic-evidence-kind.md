# ADR 0020 — Diagnostic evidence kind

**Status:** Accepted · **Date:** 2026-08-20

## Decision

`EvidenceKind` (`core/tools/contract.ts`) gains a sixth variant, `"diagnostic"`.
`DiagnosticEvidenceRecord` is a discriminated union so its status-specific fields
cannot be combined incorrectly:

```ts
export interface DiagnosticSeverityCounts {
	error: number;
	warning: number;
	information: number;
	hint: number;
	unspecified: number;
	other: number;
}

export type DiagnosticUnavailableKind =
	| "no-server"
	| "disposed"
	| "unsupported-sync"
	| "timed-out"
	| "aborted"
	| "superseded"
	| "server-failed";

export type DiagnosticEvidenceRecord =
	| {
		kind: "diagnostic";
		path: string;
		status: "ok";
		serverId: string;
		diagnosticCount: number;
		severityCounts: DiagnosticSeverityCounts;
		truncated: boolean;
	  }
	| {
		kind: "diagnostic";
		path: string;
		status: "unavailable";
		serverId?: string;
		unavailableKind: DiagnosticUnavailableKind;
	  };
```

A successful record always identifies the selected server. An unavailable record
includes `serverId` only when the collector obtained the selected connection before the failure. Outcomes
such as `"no-server"`, disposal before selection, and acquisition failure have no
server ID to report.

`diagnosticCount` counts the bounded diagnostic array observed by the mutation tool.
`severityCounts` is zero-filled across the four LSP severities plus `unspecified` for
diagnostics with no severity and `other` for numeric severities outside 1 through 4.
Only `diagnosticCount === 0` means clean. The collector currently retains at most 1,000
diagnostics; `truncated` records whether the server published more than that bound.

The live `DiagnosticsOutcome` gains the same `serverId`, `unavailableKind`, and
`truncated` facts. Its unavailable variant retains the existing human-readable
`reason` for rendering, but evidence capture never copies that string. Caught errors
can contain workspace paths or server-controlled text and are neither a stable nor a
privacy-safe durable fact. `unavailableKind` is the allowlisted durable classification.

`edit` and `write` add `"diagnostic"` to their `emits` sets. Their `capture()` functions
continue to emit existing diff evidence and add one diagnostic record when
`result.details?.diagnostics` is present. When diagnostics operations were not
injected, that field is absent and no diagnostic record is emitted. This preserves the
LSP.4 guarantee that a session with no configured LSP has unchanged tool results and
evidence.

`docs/architecture/contracts.md` § 1.4 adds the new kind. The LSP spec and roadmap are
amended to record that the previously deferred LSP.6 decision is accepted and being
implemented.

## Why this shape

Evidence records what the tool execution path observed. It does not reconstruct facts
from rendered output. The diagnostics outcome is already available inside the mutation
tool before presentation formatting, so this is the correct capture seam.

Diagnostic `message`, `source`, and `code` fields can contain source text or other
server-controlled content. They never enter evidence. The bounded counts preserve the
facts a policy consumer needs without turning the session ledger into a content or
server-output store.

A flat count is insufficient because errors and hints have different meanings. Severity
buckets alone are also insufficient because LSP severity is optional and future or
invalid numeric values can occur. The required total, `unspecified`, and `other` fields
prevent a non-empty result from looking clean.

The successful and unavailable variants carry different facts. A discriminated union
makes those invariants part of the TypeScript interface rather than prose. In
particular, it prevents an unavailable record from carrying counts and prevents a
successful record from carrying an unavailability reason.

## Compatibility and blast radius

The durable evidence readers in `core/evidence.ts`, `core/evidence-policy.ts`, and
`core/session-manager.ts` consume `EvidenceRecord` generically and do not switch over
literal evidence kinds. The session format already requires readers to tolerate future
evidence variants, so adding the union member is compatible with existing session
records.

The implementation changes these production interfaces:

- `core/tools/contract.ts` adds the evidence kind and record types;
- `core/tools/diagnostics.ts` extends the tool-local outcome and owns the conversion to
  privacy-safe evidence;
- `core/lsp/diagnostics.ts` supplies server identity, stable unavailable kinds, and the
  truncation fact;
- `core/tools/edit.ts` and `core/tools/write.ts` declare and capture the new kind;
- the tools barrel and package root export the named diagnostic types because
  `EditToolDetails` and `WriteToolDetails` already expose the outcome through public
  declaration files.

Exact-shape and producer tests under `test/lsp/` change with the outcome interface.
`test/evidence/file-mutation-capture.test.ts` explicitly covers successful counts,
unavailable classification, privacy, the no-LSP contract and record omission rule, and
the existing diff record.

## Consequences

- A configured mutation emits one additional O(1) durable record. It performs no new
  I/O and makes no additional language-server request.
- Clean means an `"ok"` outcome with `diagnosticCount: 0`, not an empty severity object.
- Consumers can distinguish a complete bounded result from a truncated one.
- Durable evidence cannot explain a server failure in free-form prose. The rendered
  tool result still can; the evidence ledger intentionally records only its stable
  classification.
- Adding fields to `DiagnosticsOutcome` is an additive public declaration change, but
  custom `DiagnosticsOperations` implementations must return the new required facts.

## Rejected alternatives

- **Persist diagnostic messages or a hash of the diagnostic array.** Messages can quote
  source and are server-controlled. A hash has no persisted artifact against which a
  later consumer can re-verify the transient result.
- **Persist the live unavailable `reason`.** The current catch path can contain paths,
  process errors, or server-controlled JSON-RPC messages. Size-bounding the string would
  not make it a stable or privacy-safe fact.
- **Store only severity buckets.** Missing or unknown severities could produce all-zero
  buckets for a non-empty result. A required total and catch-all buckets avoid that
  false-clean state.
- **Require `serverId` for every unavailable result.** Some outcomes happen before
  selection, so no truthful value exists.
- **Emit an unavailable marker when LSP is not configured for the session.** Diagnostics
  did not run in that case. Emitting a record would break the no-LSP compatibility
  guarantee and would claim an observation that did not occur.
