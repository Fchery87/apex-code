# ADR 0035 — `bash` applies a default wall-clock timeout of one hour

**Status:** Accepted · **Date:** 2026-09-19

The `bash` and PowerShell tools apply a 3600-second wall-clock timeout when the call supplies
no `timeout`. The firing message names both escape hatches: an explicit larger `timeout`, and
the background shell.

## Decision

`resolveTimeoutMs` returned `undefined` for an absent `timeout`, and the schema's own
description said "optional, no default timeout". A command that never exits therefore held the
tool call open for the life of the session. A process waiting on stdin that nothing will write,
a network call with no timeout of its own, and an interactive prompt the harness cannot answer
all reach that state without failing, so nothing else in the loop notices.

The spec
`docs/specs/2026-09-11-trust-classification-and-proof-integrity.md` required the value to come
from recorded long runs with the host named, not from taste, because it changes behavior for
every existing user.

## The measurement

Host: this repository's development machine, Linux 7.0.0-31-generic, 4 cores, load average
between 10 and 15 during the runs below. Under-load numbers are the right direction for a
ceiling: they overstate how long legitimate work takes, so a default derived from them cannot
be too tight.

The longest legitimate command this repository asks anyone to run is its own suite. Three full
`npm test` runs are recorded under `.apex-code/run-logs/`:

| Run | Wall clock |
| --- | --- |
| `full-suite-2026-09-09.log` | 921.09 s |
| `full-suite-2026-09-10.log` | 1583.65 s |
| `full-suite-2026-09-10-final.log` | 1665.73 s |

The slowest is 1665.73 s, about 27.8 minutes. `npm run check` and `npm run build:offline` are
both well under it.

3600 s is 2.16× that slowest observed run. The margin is deliberate: a default that merely
cleared the measurement would kill the first suite run on a machine slower or busier than this
one, and a default that kills real work is worse than one that lets a hung command sit, because
a kill looks like a failing build.

## Why not shorter, and why not none

A shorter default reads better. Five minutes would catch a wedged process quickly. It would
also kill this repository's own test suite, which is the single command a coding agent is most
likely to run, and the failure would present as a test-suite failure rather than as a timeout.
That is the expensive mistake.

Keeping no default was the status quo and is what this changes. An unbounded default is not
neutral: it makes "hung" and "slow" indistinguishable forever, and the session has no other
mechanism that notices.

One hour is long enough that a user meets it only when something is genuinely wrong, and the
message they get when they do names the two ways forward rather than only reporting the kill.

## Consequences

A command that previously ran unbounded and legitimately takes more than an hour now fails once
with a message naming `timeout` and the background shell. That is a behavior change for a real
workflow, and it is the cost of the default existing at all. The background shell is the better
answer for that workflow anyway, since an hour-long foreground call holds the agent loop.

`MAX_TIMEOUT_MS` is unchanged at the 32-bit `setTimeout` ceiling, so an explicit larger value
remains expressible up to about 24.8 days.

The value is a constant with the measurement cited beside it, not a setting. A setting would ask
every user to answer a question this ADR answers once, and the per-call argument already covers
the case where the answer is wrong.
