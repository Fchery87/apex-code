# Apex Code

A provider-agnostic agentic coding harness. Forked from [Pi](https://github.com/earendil-works/pi).

> **Status: pre-alpha, Phase 0.** Nothing is installable yet. The roadmap is real;
> the code is not. See [`docs/roadmap.md`](docs/roadmap.md) for what exists and what
> is next. Everything below marked *(planned)* describes intent, not current
> behavior — this section will shrink as phases land.

## Why

Pi has the best foundations of any coding harness we surveyed: a provider layer
covering 35 providers across 9 API dialects, a clean agent-loop contract with real
interception points, a tree-structured session format that branches in place, and an
extension system that can register tools, commands, and providers at runtime.

What it does not have is a safety floor or a capability surface. There is no
permission system and, by explicit design, no sandbox — project trust is a guard on
*loading* config, and does nothing once a turn starts. The core ships seven tools.

Apex Code keeps the foundations and builds the rest:

- **Provider-agnostic in the operational sense** *(planned, Phase 1)* — credential
  pooling with failover, model roles, fallback chains, and routing driven by measured
  latency rather than guesswork.
- **A real permission model and sandbox** *(planned, Phase 2)* — allow/deny/ask rules
  with source precedence, per-tool rule grammars, and OS-level filesystem and network
  restriction underneath.
- **Context that scales** *(planned, Phase 3)* — tool-result eviction and deferred
  tool schemas, so a large tool surface and long sessions stay affordable.
- **Evidence, not assertions** *(planned, Phase 7)* — exit codes, patch hashes, and
  argv captured by the tool that produced them, so "it passed" can be checked rather
  than believed.

## Design commitments

- **No vendor lock.** The provider layer is upstream `pi-ai` and stays that way. Any
  model reachable through it is a first-class model here.
- **Safety before capability.** Permissions and context budget land before the tool
  surface expands. A harness that is more capable and measurably worse is a
  regression.
- **Every phase exits on a number.** Phase gates are measurable against a replay
  corpus, not declared done by feeling.

## Relationship to upstream

Apex Code forks `pi-coding-agent` and `pi-agent-core`, and **consumes** `pi-ai` and
`pi-tui` as ordinary dependencies. That boundary is deliberate: the provider layer is
the part of Pi that needed no improvement, and rewriting 35 providers would be the
most expensive way to gain nothing. See [ADR 0001](docs/adr/0001-fork-boundary.md).

Upstream changes are merged on a defined cadence with a patch-surface ceiling and an
explicit abandonment tripwire — see [ADR 0003](docs/adr/0003-upstream-merge-cadence.md)
and `docs/upstream-log.md`.

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/roadmap.md`](docs/roadmap.md) | Phases, exit criteria, current status |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | Layer map: what is forked, consumed, and extended |
| [`docs/architecture/contracts.md`](docs/architecture/contracts.md) | Interfaces several phases write to, settled up front |
| [`CONTEXT.md`](CONTEXT.md) | Glossary and relationship map |
| [`AGENTS.md`](AGENTS.md) | Operational rules for coding agents |
| [`docs/adr/`](docs/adr/) | Settled decisions |
| [`docs/specs/`](docs/specs/) | Design documents, written before each change |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute |
| [`SECURITY.md`](SECURITY.md) | Reporting a vulnerability |

## Requirements

Node.js ≥ 22.19.0.

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for third-party attribution.
