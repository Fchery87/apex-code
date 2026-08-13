# Replay corpus

This directory contains deterministic, scrubbed-format session fixtures for Apex
Code's offline replay and metrics gates.

## Provenance and privacy

These fixtures are synthetic. They were authored from Apex Code's public session
schema and use only fictional prompts, responses, paths, identifiers, tool results,
and errors. No personal session transcript, credential, hostname, or private project
content was copied into this corpus. The shapes are representative of behavior seen
in the repository's licensed upstream test fixtures, but their content is newly
written for Apex Code.

Every fixture must pass `fixtures/__tests__/corpus-hygiene.test.ts`, which enforces:

- no credential-shaped or high-entropy secret values;
- no personal home paths, email addresses, hostnames, or IP addresses;
- valid JSONL;
- one version 3 session header;
- unique entry IDs and connected `id`/`parentId` edges; and
- valid compaction, branch-summary, and label entry references.

Run the gate with:

```bash
npm run test:scrubber
```

The gate was deliberately exercised with a temporary synthetic `sk-live_...` fixture
during Task 0.7. It failed on the injected credential, and passed again only after the
fixture was removed.

## Coverage

| Fixture | Turns | Tool calls | Compactions | Models | Replay behavior |
| --- | ---: | ---: | ---: | ---: | --- |
| `short-single-turn.jsonl` | 1 | 0 | 0 | 1 | Minimal user/assistant turn |
| `long-multi-turn.jsonl` | 22 | 0 | 0 | 1 | Consecutive turns for turn-20 metrics |
| `long-tool-heavy.jsonl` | 22 | 10 | 0 | 1 | Long *and* tool-heavy, with nonzero cache usage — the only fixture where tool-result eviction and `cacheHitRate` are measurable at turn 20 |
| `compacted-session.jsonl` | 22 | 0 | 1 | 1 | Long run continuing through a compaction entry |
| `heavy-tool-output.jsonl` | 1 | 1 | 0 | 1 | Large deterministic result for eviction measurements |
| `model-switch.jsonl` | 2 | 0 | 0 | 2 | Provider/model change in the middle of a session |
| `error-recovery.jsonl` | 2 | 0 | 0 | 1 | Assistant error followed by a successful retry |
| `branched-session.jsonl` | 3 | 0 | 0 | 1 | Two children from one parent plus a branch summary |
| `tool-error-recovery.jsonl` | 1 | 2 | 0 | 1 | Failed tool result followed by a fallback tool call |

## Turn-20 metrics and why `long-tool-heavy.jsonl` exists

Phase 3's exit criterion reads *median context tokens at turn 20*, so only fixtures
with at least 20 user turns contribute to it. Until 2026-08-13 that was two fixtures,
`long-multi-turn` and `compacted-session`, and **both contain zero tool calls and zero
tool results**. Tool-result eviction — the technique that phase is largely about — had
nothing to evict in either, so the gate could not observe it at all. Every fixture also
recorded `cacheRead: 0`/`cacheWrite: 0`, making `cacheHitRate` a constant zero, even
though `docs/architecture/contracts.md` § 2 requires the eviction ordering be decided
against that number.

`long-tool-heavy.jsonl` closes both gaps in one fixture: 22 user turns, 10 interleaved
`read`/`grep` calls whose results accumulate in context, and realistic nonzero cache
usage. Adding it moves the turn-20 median from 935 to 1,117, because a median over
three values is the middle one rather than a mean of two. That is a deliberate,
recorded change to the baseline, not a re-recording of the existing fixtures — those
two are untouched, and the gate is only meaningful measured against a corpus where the
technique under test is visible.

## Editing rules

Keep the corpus deterministic and offline. Use fictional content and `$HOME` for home
paths. Never paste a credential—even an expired one—or a personal transcript here.
Run the hygiene gate before committing any fixture change.
