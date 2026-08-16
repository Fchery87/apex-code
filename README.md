# Apex Code

A provider-agnostic agentic coding harness. Forked from [Pi](https://github.com/earendil-works/pi).

> **Status: pre-alpha — Phases 0 through 10 landed.** All of the differentiated features below are built, not just
> planned. See [`docs/roadmap.md`](docs/roadmap.md) for exit criteria and current
> status, phase by phase.

Install the prerelease without moving npm's stable `latest` tag:

```bash
npm install --global apex-code@next
apex-code --version
```

New to Apex Code? [`docs/user-guide.md`](docs/user-guide.md) covers install, first
run, and where to go next.

## Why

Pi has the best foundations of any coding harness we surveyed: a provider layer
covering 35 providers across 9 API dialects, a clean agent-loop contract with real
interception points, a tree-structured session format that branches in place, and an
extension system that can register tools, commands, and providers at runtime.

Upstream Pi, on its own, does not have a safety floor or a capability surface: no
permission system and, by explicit design, no sandbox — project trust is a guard on
*loading* config, and does nothing once a turn starts. The core ships seven tools.

Apex Code keeps the foundations and has built the rest:

- **Provider-agnostic in the operational sense** *(landed, Phase 1)* — credential
  pooling with failover, model roles, fallback chains, and routing driven by measured
  latency rather than guesswork.
- **A real permission model and sandbox** *(landed, Phase 2)* — allow/deny/ask rules
  with source precedence, per-tool rule grammars, and OS-level filesystem and network
  restriction underneath, on Linux and macOS.
- **Context that scales** *(landed, Phase 3)* — tool-result eviction and deferred
  tool schemas, so a large tool surface and long sessions stay affordable.
- **A real tool surface, safely delegated** *(landed, Phases 4–5)* — the expanded
  tool set and subagent delegation, both bound by the same permission gate.
- **Durable state and evidence, not assertions** *(landed, Phases 6–7)* — a daemon
  that survives a crash mid-command, and exit codes, patch hashes, and argv captured
  by the tool that produced them, so "it passed" can be checked rather than believed.
- **Cost and latency you can see** *(landed, Phase 8)* — per-model/session/role cost
  and latency, `apex-code cost`, and optional OTLP trace export to your own
  collector — never to this project.

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
| [`docs/user-guide.md`](docs/user-guide.md) | Install, first run, and core concepts |
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
