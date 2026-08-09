# Contributing to Apex Code

Apex Code is pre-alpha and moving fast. Before investing in a large change, open an issue
— the roadmap phase order is deliberate and dependency-driven, and work that jumps
ahead of its phase usually has to be redone.

## Before anything else: source hygiene

Apex Code is MIT and distributed. **Contributions must be your own work or drawn from
compatibly licensed sources.**

Do not submit code copied or adapted from leaked, proprietary, or unlicensed
codebases, whatever its provenance and however it reached you. This is not a
formality — a single contaminated function is a licensing problem for every
downstream user. If a design idea comes from studying another system's *behavior*,
say so in the PR and describe the behavior; do not paste its implementation.

By opening a pull request you confirm you have the right to contribute the code
under the MIT License. See [ADR 0002](docs/adr/0002-clean-room-sources.md).

## Getting set up

Requires Node.js ≥ 22.19.0.

```bash
git clone <repo-url> apex-code
cd apex-code
npm install
npm run typecheck
npm test
```

## The development loop

Apex Code is built test-first. The loop:

1. Write the failing test.
2. Run it. Confirm it fails, and that it fails for the reason you expect — a test
   that errors on a typo has not tested anything.
3. Write the minimal implementation.
4. Run the test. Confirm it passes.
5. Run the narrowest relevant suite, then commit.

Two rules that catch most problems:

- **Test the public boundary under change**, not the private implementation beneath
  it. Tests coupled to internals block the refactors they were meant to protect.
- **Tests must not write into the repo's own state.** Anything that drives a turn,
  writes a session, or records evidence must `chdir` to a scratch directory first.

## Working with forked code

Apex Code forks `pi-coding-agent` and `pi-agent-core` and consumes `pi-ai` and `pi-tui`
([ADR 0001](docs/adr/0001-fork-boundary.md)).

- **Do not vendor or patch `pi-ai` or `pi-tui`.** Extend through their public APIs.
  If you believe something requires patching them, open an issue — it may be an
  upstream contribution instead.
- **Keep forked files legible as a diff against upstream.** Reformatting, renaming,
  or restructuring a forked file raises the cost of every future merge. Gratuitous
  churn in forked code will be asked to be reverted, even when the change itself is
  an improvement.
- **Never rename a directory under `packages/`.** They keep upstream's paths on
  purpose — `packages/coding-agent` is the Apex Code package despite the name. The
  npm name and the binary carry the product identity; the paths carry merge
  compatibility with an upstream that changes ~57 files per patch release. PRs that
  "fix" the paths will be closed (ADR 0001).
- Genuine improvements to `pi-ai` or `pi-tui` should go upstream to Pi, not into a
  local patch.

## Documentation

Apex Code uses four document types with different lifecycles. Put content in the right
one — see `AGENTS.md` § Documentation rules.

- Nontrivial changes need a **spec** in `docs/specs/` before implementation, using
  `docs/specs/TEMPLATE.md`. The deletion inventory is required.
- Multi-step work gets a **plan** in `docs/plans/`, which is deleted when complete.
- Irreversible or contested decisions get an **ADR**.

Do not write specs or plans for future roadmap phases. They are written when the
preceding phase exits.

## Commits and pull requests

- Small, focused commits with a real message. "fix stuff" costs the next reader more
  than it saved you.
- A PR should describe what changed, why, and how it was verified — with the actual
  command and output, not a claim.
- Do not claim verification you did not run. This matters more here than in most
  projects: Apex Code's own thesis is that evidence beats assertion.
- Green CI is required: typecheck, lint, and tests.

## Security

Do not open a public issue for a security-sensitive report. See
[`SECURITY.md`](SECURITY.md).
