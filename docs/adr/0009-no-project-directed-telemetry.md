# ADR 0009 — No project-directed telemetry; what looked like some was a bug

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Apex Code sends **no usage data to the Apex Code project**, by default or
otherwise. There is no telemetry to opt into. Two mechanisms that appeared to
serve this role at the start of Phase 9 turned out, on inspection, to be
something else:

1. **`reportInstallTelemetry()`** fired a `GET https://pi.dev/api/report-install`
   ping on detected version upgrades. It never sent data to this project — it sent
   Apex Code's own version number to **upstream Pi's** telemetry endpoint, under a
   `pi/<version>` User-Agent, unmodified since the fork. Deleted; see
   `docs/specs/2026-08-16-release-hardening.md`.
2. **`enableAnalytics`/`trackingId`** was a settings pair with a full onboarding UI
   step asking every new user to opt in — and zero production code that read the
   setting to send anything, ever. Deleted along with the onboarding step.

Neither was project-directed telemetry working as designed with a bad default;
both were dead or misdirected code inherited from the fork. There was no live
in-scope decision to make about their *default* — they are gone.

**Provider-attribution headers are a separate thing and are not telemetry.**
`provider-attribution.ts` attaches identifying headers (e.g. OpenRouter's
`X-OpenRouter-Title`) to requests already going to the LLM provider *the user
configured* — for that provider's own billing-origin attribution, never to a
third party. Governed by `sendProviderAttribution` (default `true`), a
deliberately separate, honestly-named setting — not a telemetry opt-out
repurposed to mean something else.

**OTLP export (ADR 0012, Phase 8) is also not this.** It sends data to a
collector *the user names*, never to this project. ADR 0012 already drew that
line; this ADR does not revisit it.

## Why this shape

The roadmap asked this phase to settle "opt-in-only telemetry, and exactly what
is collected." Tracing every consumer of the settings that looked like the
answer — not just reading their defaults — found there was no working
project-directed telemetry to make opt-in in the first place. Two paths were
available once that was clear: build a real, working, opt-in mechanism from
nothing, or delete what was broken/dead and record that the honest answer is
"nothing is collected." The former is new infrastructure and a new privacy
commitment this session was not asked to design and has no product mandate to
invent. The latter is corrective, verifiable today, and matches the phase's
explicitly chosen scope (infrastructure-only, no new collection surfaces).

This is a narrower, more concrete decision than the roadmap anticipated when it
reserved this slot — it expected a policy choice about telemetry defaults; what
was actually there needed removal, not a default flipped.

## Consequences

- A future decision to add real project-directed telemetry starts from zero,
  with a clean, honest baseline, not from re-purposing a setting whose name
  no longer means what it says.
- `docs/user-guide.md` and `NOTICE` make no telemetry claims requiring a list
  of "what is collected," because nothing is.
- If provider-attribution headers are ever mistaken for telemetry again, the
  fix is documentation, not code — the boundary drawn here (own-provider
  attribution vs. project-directed collection vs. user-named OTLP export) is
  the same three-way distinction ADR 0012 already established for OTLP;
  this ADR extends it to the two mechanisms ADR 0012 didn't cover.

## Rejected alternatives

**Keep `enableInstallTelemetry` and just fix the URL to point at an Apex Code
endpoint.** Rejected: Apex Code operates no such endpoint, and standing one up
is real infrastructure and a real data-collection commitment — exactly the new
surface this phase's chosen scope (infrastructure-only, pre-alpha) excludes.
Recorded as a live option for a future phase if the project ever wants it, not
foreclosed by this ADR.

**Keep the analytics opt-in setting, wire it to something later.** Rejected: an
onboarding prompt asking for consent to a feature that does not exist is worse
than no prompt, not a harmless placeholder — see
`docs/specs/2026-08-16-release-hardening.md`'s finding that the dialog
referenced a `/privacy` command that has never existed.
