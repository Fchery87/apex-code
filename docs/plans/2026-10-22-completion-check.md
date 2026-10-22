# Plan: Completion check

**Status:** Active

Spec: `docs/specs/2026-10-22-completion-check.md`

| Task | State | Commit |
| --- | --- | --- |
| Decision function and unit tests | done | `b93728acb` |
| Apply the decision after a user turn | done | `fb16df534` |
| `/goal` slash command | done | `fb16df534` |

## Order

The decision function has no session dependency, so it lands first. The session wiring needs a test that drives a turn and asserts one follow-up, and that test must `chdir` to a scratch directory. The slash command comes last because it only sets the session value.
