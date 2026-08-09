# AGENTS

Operational rules for coding agents working in this repo. Read this before your
first edit. Background and rationale live in `docs/` — this file is rules only.

## What this repo is

Apex Code is a provider-agnostic agentic coding harness, forked from Pi. We fork
`pi-coding-agent` and `pi-agent-core`; we **consume** `pi-ai` and `pi-tui` as
upstream dependencies (ADR 0001). Read `CONTEXT.md` for the glossary and
`docs/roadmap.md` for what phase we are in.

## The one rule that must never be broken

**Never copy from `c-code` or any other leaked or unlicensed source.** The leaked
Claude Code tree at `~/Documents/Coding Projects/c-code` is `UNLICENSED`. Apex Code ships
MIT. Copying from it — a file, a function, a type, a distinctive string, a comment —
contaminates the license of a distributed product.

- Do **not** open, read, grep, or check out `c-code` while working in this repo.
- Its ideas enter Apex Code through one channel only: the behavioral descriptions already
  captured in `docs/research/`. Cite the research doc, not the source.
- If a task seems to require reading it, stop and escalate. Do not decide this
  yourself.

See ADR 0002. This is a legal boundary, not a style preference.

## Validation gates

- Run `npm run typecheck` regularly while editing TypeScript.
- Run the narrowest relevant test file before broadening scope.
- Run `npm test` once at the end of a completed implementation slice.
- Never claim verification you did not run. Paste the command and its real output.

## Test discipline

- **Test-first.** Write the failing test, run it, watch it fail for the right
  reason, then implement. A test that has never failed has proven nothing.
- **Tests must not write into the repo's own state.** Any test that drives a turn,
  writes a session, or touches the evidence ledger must `chdir` to a scratch
  directory first. Otherwise the suite ends up measuring itself — a real failure
  mode inherited from the predecessor harness.
- Test the public boundary under change, not the private implementation beneath it.

## Upstream discipline

- `pi-ai` and `pi-tui` are dependencies. Do not vendor, patch, or fork them. Extend
  through `registerProvider()` and the public APIs (ADR 0001).
- Changes to forked code should stay legible as a diff against upstream. Before a
  wide refactor of forked files, check whether it raises the merge cost past the
  ceiling in ADR 0003.
- Record every upstream merge's hunk count in `docs/upstream-log.md`.

## Documentation rules

Four document types, each with a different lifecycle. Put content in the right one.

| Type | Path | Lifecycle |
| --- | --- | --- |
| Roadmap | `docs/roadmap.md` | Permanent. One file. Phase status table. |
| Spec | `docs/specs/YYYY-MM-DD-<slug>.md` | Permanent. Written *before* a nontrivial change. |
| Plan | `docs/plans/YYYY-MM-DD-<slug>.md` | **Deleted on completion.** Task breakdown. |
| ADR | `docs/adr/NNNN-<slug>.md` | Permanent. One settled decision. |

- Every plan opens with a `**Status:**` line. Without one there is no way to tell a
  live plan from a finished one.
- A completed plan is **deleted**, not archived in place. Git keeps it
  (`git show <commit>:docs/plans/<name>`). Anything durable in it belongs in an ADR
  or a spec.
- Every spec carries a **deletion inventory** — what the change makes obsolete. The
  section is required even when the answer is "nothing."
- Do not write specs or plans for future phases. They get written when the previous
  phase exits, because they would otherwise be wrong by the time they are read.

### Recording progress

Two places, and only two. Do not add a third — a `PROGRESS.md` would immediately
disagree with both.

- **The plan's task table** is the status board: state plus the real commit SHA for
  every finished task. Update it in the same commit that finishes the task, not later.
- **The roadmap's phase table** carries phase-level state and links to the live spec
  and plan.

Three rules that come from having gotten this wrong:

1. **Verify a SHA before writing it down.** This repo's history was rewritten once, on
   2026-08-08, which killed every hash recorded before it. Run `git cat-file -t <sha>`;
   if it fails, the hash predates the rewrite and must be found again by commit subject.
2. **Mark a task done only when it is verified**, and say what is missing when it is
   not. "Done, unverified — needs one green CI run" is a real state and is more useful
   than either "done" or "not started".
3. **When work happens out of order, fix the order — don't just annotate it.** If a
   task ran early because the documented sequence was wrong, reorder the table and
   record why in an "Order changes" section. A note saying "we did this early" teaches
   nothing; a corrected sequence stops the next person repeating the mistake. Task
   numbers are identifiers, never a sequence — renumbering breaks references in docs
   and in pushed commit messages.

## Tools

Every tool declares a `contract` — capabilities, permission grammar, context
behavior, evidence emission. It is required and so is every sub-field; a tool that
does not answer all four axes does not compile. See
`docs/architecture/contracts.md` § 1 and ADR 0010.

Never re-derive a tool's capability, risk, or permission classification. One
projection, `buildToolContractSnapshot()`, serves every surface that describes the
tool registry. A second independent classification is the drift ADR 0010 exists to
prevent.

## Scope rules

- Do not revert or rewrite unrelated user changes.
- If the branch is red, isolate the failing seam, repair it, re-run the tight loop,
  then expand.
- Keep artifact-heavy output under `.apex-code/` and return references, not inlined
  payloads.

## Secrets

No API key, token, or credential is ever written to a file this repo tracks, and
never to a config file the loader writes. Keys come from the credential store or the
environment. If you find one committed, stop and report it — treat it as leaked.
