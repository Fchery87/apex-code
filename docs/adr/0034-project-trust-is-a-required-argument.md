# ADR 0034 — Project trust is a required argument, not a defaulted one

**Status:** Accepted · **Date:** 2026-09-19

The three constructors that read project-controlled bytes off disk take `projectTrusted` as a
required argument. Omitting it is a type error for a TypeScript caller and a thrown error for a
JavaScript one. Nothing defaults to trusted.

## Decision

`docs/specs/2026-09-11-trust-classification-and-proof-integrity.md` closed the hole where four
project resources reached their loaders without reaching the classifier. It left a second hole
of the same shape open, and the spec's Rollout blocked closing it on this ADR because it breaks
a published API.

Three constructors accepted the resolved trust decision and treated its absence as trust:

| Site | Shape | Effect of omission |
| --- | --- | --- |
| `core/permissions/store.ts` | `options.projectTrusted ?? true` | project and local grants load |
| `core/settings-manager.ts` | `options.projectTrusted ?? true` | project settings load |
| `core/mcp/runtime.ts` | `options.projectTrusted === false ? undefined : …` | project `.mcp.json` loads |

The registry made the classifier and the loaders agree on *which* paths are gated. It did
nothing about *whether the gate was consulted*, because a caller that never passes the flag
satisfies every gate by default. A forgotten argument and a deliberate `projectTrusted: true`
were indistinguishable at the call site and in review.

The argument is now required. `CreateFilePermissionRuleStoreOptions.projectTrusted` and
`SettingsManagerCreateOptions.projectTrusted` lose their `?`, the options bag itself becomes a
required parameter on `SettingsManager.create`, and `createMcpRuntime` takes the flag as a named
required field rather than inferring trust from an inequality.

Each also validates at runtime. The type alone protects only TypeScript, and
`docs/adr/0027-agent-harness-not-public-api.md` notwithstanding, `packages/coding-agent` is
published to npm and JavaScript callers reach these constructors with no compiler between them.
A missing flag throws rather than trusting.

## Why not a safe default instead

Flipping `?? true` to `?? false` needs no call-site changes and closes the hole for anyone who
forgets. It was still rejected, though not for the reason first drafted here.

The draft claimed four production sites legitimately meant trusted. Making the argument required
and reading what the compiler named disproved that. Not one of them has a trust answer at its
call point:

| Site | What it is | Correct value |
| --- | --- | --- |
| `main.ts` startup manager | runs at line 707; `ProjectTrustStore` is not constructed until 768 | untrusted |
| `resource-loader.ts` fallback | the bootstrap pass its own comment calls "force untrusted" | untrusted |
| `agent-session-services.ts` fallback | reached only when no caller supplied a manager | untrusted |
| `sdk.ts` fallback | same | untrusted |

So a fail-closed default would have produced the right behavior at all four. It was rejected on a
different ground: it produces the right behavior *silently*. The omission stays invisible, and the
next loader added under it inherits a decision nobody took. The failure mode of a wrong default is
a missing setting with no error, which is the hardest kind to trace.

The finding that survives is that there is no default worth writing down. A caller that has not
resolved trust cannot be given either answer, because both are a guess about an untrusted
checkout. Making the argument required is the only shape that says so, and it is what turned four
invisible omissions into four stated answers.

### One behavior change this exposed

`main.ts`'s startup manager read the merged settings, so `getSessionDir()` honored a project
`.apex-code/settings.json` before any trust decision existed. A cloned repository could choose
where that session's transcripts were written. It now reads global scope only.

The cost is that a project-level `sessionDir` no longer applies, for a trusted project as well as
an untrusted one, because the session manager is built before trust resolves and is not rebuilt
after. Re-reading it post-decision is the fix if anyone wants the setting back; it is a startup
ordering change rather than a line, so it is not made here.

## Scope, and one deliberate exclusion

`SettingsManager.inMemory` keeps its optional options bag and its trusted default.

Its storage is `InMemorySettingsStorage`, whose project scope holds whatever the caller wrote
into it. No byte comes from the checkout, so there is no untrusted source to gate and no
decision for the caller to make. Requiring the flag there would add 59 call-site edits that each
record a decision nobody took.

That is the same argument the trust classifier itself settled when it chose authority over
presence: an empty `permissions.json` does not prompt, because a prompt carrying no decision
teaches people to dismiss prompts. A required argument carrying no decision teaches people to
paste `projectTrusted: true`, which is the habit this ADR exists to break.

The boundary is therefore *reads project-controlled bytes off disk*, not *is named
SettingsManager*. `create` and `fromStorage` cross it. `inMemory` does not.

## Consequences

An SDK caller constructing any of the three directly must pass the flag. There is no deprecation
window: a silent default is exactly what makes the omission invisible, so leaving one in place
for a release would preserve the defect for that release. The break is a compile error with the
argument named, which is the cheapest possible form of it.

The SDK examples pass the flag explicitly, so copied code carries the decision rather than
inheriting it, and `examples/sdk/README.md` documents the new default and what it costs. The
user guide is untouched: it does not reach these constructors.

Trust is resolved once, at startup, by `core/trust-manager.ts`. This ADR does not change when
that happens or what it decides. It changes only whether a constructor can proceed without the
answer.
