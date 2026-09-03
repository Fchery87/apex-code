# ADR 0028 — Verification and formatter policies are settings-owned, project-shadowed, and extension-additive

**Status:** Accepted · **Date:** 2026-09-03

Named verification and formatter policies (spec
`docs/specs/2026-09-01-configured-verification-and-formatting.md`) are commands a user
lets Apex Code run on their behalf. They are durable configuration, saved into settings
files a user may forget about, so their ownership and precedence rules are settled here
before any loader exists. A policy that could be silently added, re-spelled, or widened by
a repository a user merely opened would turn "configure your project's check" into
"let any repo you touch run its code." That failure mode, not the exact schema, is what
this ADR governs.

**Policies live under the `policies` settings key, versioned by `schemaVersion`.
Precedence for a policy ID is project over user, and only inside a trusted project.
Extensions may add policy IDs but never redefine one. Nothing runs unless a policy is
configured and its permission class admits the run.**

Four properties are the decision.

**One key, one schema version, absent by default.** `policies` carries
`schemaVersion: 1` and two arrays, `verification` and `formatter`. An absent key
constructs no runtime, spawns nothing, and changes no behavior — the same inertness rule
as `hooks`. A `schemaVersion` the loader does not know is a load error, not a best-effort
guess: policy fields gate command execution, and "probably means the same thing" is
exactly the drift this ADR exists to prevent.

**Project shadows user per policy ID, but only inside a trusted project.** The settings
layer already refuses to load any project-scope configuration before the project-trust
decision, and policies inherit that gate unchanged: an untrusted project contributes zero
policies, so opening an untrusted repo cannot inject a verification command that later
runs. Within a trusted project, a project policy with the same ID replaces the user
policy with that ID — the project owns its checks, and a user who wants a different
command for this repository can say so in the project file they have already trusted.
Raw per-source settings stay readable (`getGlobalSettings()` / `getProjectSettings()`)
precisely so the resolver never has to trust the merged view, where same-key array
replacement makes provenance invisible.

**Extensions are additive.** An extension may register new policy IDs; a policy ID
defined by user or project settings is final and an extension redefinition is rejected at
registration. Extensions are project- and user-installed code with every incentive to
"fix" a policy's timeout or permission class; additive-only keeps them from ever relaxing
what a human wrote. Within one source, duplicate IDs are a strict load error — the same
ID must mean one command.

**The declared permission class is a ceiling, not a floor.** `permission:
"allow" | "ask" | "deny"` says what the policy may ask for; session permission mode,
sandbox boundary, and the canonical tool contract (ADR 0010, ADR 0004) still cap what any
invocation may do. A user-level `allow` policy in a sandboxed or restricted session runs
only if those layers admit it. Verification maps to the `exec` capability; a formatter is
`exec` plus `fs.write` confined to its declared paths.

## Consequences

- The settings schema gains one optional `policies` key; existing files remain valid and
  behave exactly as before.
- The VF.2 loader implements strict validation (argv required, numeric bounds, path
  confinement, unknown `schemaVersion`, duplicate IDs per source) against these rules.
- Extension policy registration (later slice) needs the additive-only check at
  registration time, which is why the rule is settled now.
