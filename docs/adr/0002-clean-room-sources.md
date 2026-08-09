# ADR 0002 — Leaked and unlicensed sources are behavior specifications, never code sources

**Status:** Accepted · **Date:** 2026-08-08

Apex Code's design was informed by a comparative review of five harnesses
(`docs/research/2026-08-08-harness-comparative-review.md`). Four are MIT. The fifth,
referred to as `c-code`, is leaked Claude Code source, marked `UNLICENSED` in its own
`package.json`. It is also the single richest source of ideas in the review: the
permission rule model, tool-result eviction, deferred tool schemas, and several loop
recovery behaviors were all observed there first.

Apex Code ships MIT and is distributed publicly. That combination makes this a legal
boundary rather than a preference: a single copied function is a licensing defect for
every downstream user, and it is not fixable after the fact by deletion, because the
history retains it.

**Ideas from unlicensed sources may enter Apex Code only as behavioral descriptions.
Implementation never crosses.**

Concretely:

- Copying is prohibited at every granularity — file, function, type definition,
  schema, distinctive string, comment, or a structure that only makes sense as a
  transcription. "Rewrote it in my own words while looking at it" is not clean-room
  and is not permitted.
- `c-code` must not be open, checked out, or grepped in a working tree while working
  on Apex Code, and must not be present in the build environment or in any implementing
  agent's context. This is stated as a rule in `AGENTS.md` because the realistic
  failure is an agent helpfully reaching for it, not a person deciding to.
- The one legitimate channel is `docs/research/`, which records *what a system does*
  and *why the approach is sound* without reproducing how it is written. Design
  documents cite the research doc. They do not cite the source tree.
- Everything traceable to that channel is independently designed and independently
  implemented against Apex Code's own interfaces, and reviewed as such.

This costs something and the cost is accepted: some designs will be reimplemented
less efficiently than a copy would have been, and some subtleties visible in the
original will have to be rediscovered through testing. That is the price of a clean
license, and it is small next to the alternative.

MIT-licensed prior art — Pi, and the Pi-derived forks studied in the same review —
carries no such restriction beyond ordinary attribution, which `NOTICE` records.

`CONTRIBUTING.md` extends the same requirement to outside contributors, who are asked
to confirm the provenance of what they submit.
