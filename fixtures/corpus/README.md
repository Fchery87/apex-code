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
| `compacted-session.jsonl` | 22 | 0 | 1 | 1 | Long run continuing through a compaction entry |
| `heavy-tool-output.jsonl` | 1 | 1 | 0 | 1 | Large deterministic result for eviction measurements |
| `model-switch.jsonl` | 2 | 0 | 0 | 2 | Provider/model change in the middle of a session |
| `error-recovery.jsonl` | 2 | 0 | 0 | 1 | Assistant error followed by a successful retry |
| `branched-session.jsonl` | 3 | 0 | 0 | 1 | Two children from one parent plus a branch summary |
| `tool-error-recovery.jsonl` | 1 | 2 | 0 | 1 | Failed tool result followed by a fallback tool call |

## Editing rules

Keep the corpus deterministic and offline. Use fictional content and `$HOME` for home
paths. Never paste a credential—even an expired one—or a personal transcript here.
Run the hygiene gate before committing any fixture change.
