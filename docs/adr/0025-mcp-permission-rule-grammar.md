# ADR 0025 — The MCP rule grammar names a server and a tool, and metadata is not a call

**Status:** Accepted · **Date:** 2026-08-28

A permission rule is durable in a way most of this repo's decisions are not. It is written
into a user's settings the first time they answer "always allow", and it stays there. A
rule grammar can therefore be extended later but never re-spelled: changing what
`Mcp(github:*)` means, or how it is written, silently reinterprets or voids rules users
already saved. That makes the grammar for MCP a decision to settle before the tool ships,
not after, and `docs/specs/2026-08-28-native-mcp.md` blocks its implementation on this ADR
for that reason.

Apex Code exposes every MCP server through one `mcp` proxy tool, so all of this grammar
lives under a single tool name. ADR 0010 puts `ruleContent` interpretation inside the tool,
which is what lets a grammar this specific exist without the permission engine learning any
of it.

**A rule is `Mcp(<server>:<tool>)`, with `*` permitted in the tool position only.
Metadata actions are not calls and take one separate rule, `Mcp(metadata)`.**

Three properties are the decision.

**The server is always named, and never wildcarded.** `Mcp(*:read_file)` is not expressible
and `Mcp(*:*)` is rejected rather than treated as "all MCP". A tool name means nothing
without its server: two servers may both expose `read_file` and they are different
programs with different authority. A grammar permitting a server wildcard would let a rule
written while one server was configured silently extend to a server added months later,
which is the failure the rule engine's precedence model cannot see and the user would never
be asked about again. The cost is that a user running five servers who wants to allow all
of them writes five rules. That is the intended friction.

**Metadata is separated from calls, in both directions.** `mcp({ search })` and
`mcp({ describe })` read a local disk cache and contact no server. Folding them into the
call grammar would force a user to authorize a server before they could discover what it
offers, and the model's first action on any new server is discovery. So `Mcp(metadata)`
covers exactly those two actions and cannot authorize a call, and no call rule can
authorize a metadata read. The separation is enforced in both directions on purpose: a
one-way check would let `Mcp(github:*)` quietly cover searching every other server.

**The qualified name is the model's interface too, not just the rule's.** The model calls
`mcp({ tool: "github:create_issue" })`, using the same `<server>:<tool>` string the rule
names. One spelling serves the call, the rule, and the prompt text, so there is no mapping
layer that can drift. The alternative considered was separate `server` and `tool` fields on
the call with the rule joining them, which reads slightly better in JSON and puts the
joining logic in two places.

Prefix collisions are avoided by construction rather than by escaping. The first `:`
separates, so a tool name may itself contain `:` while a server name may not, and the rule
pattern rejects a server name containing `(`, `)`, `:`, `*`, or whitespace.

## Consequences

- A user with several servers writes one rule per server. Accepted, per the reasoning
  above; a future `Mcp(*)` meaning "every configured server" could be added compatibly,
  because it is not currently expressible and so cannot already exist in anyone's settings.
- Renaming a server in `.mcp.json` orphans its rules. This is correct: the rules named a
  server that no longer exists, and the new name has never been authorized.
- The grammar is unaffected by which servers are configured. `matches` is a pure function of
  the rule and the call, so a rule for a server that is not currently configured is inert
  rather than an error, and adding that server back re-activates it.
- The capability set is not part of the grammar. One proxy tool carries one capability set,
  which is the union of configured servers, because that set feeds the delegation ceiling
  (ADR 0008) and mode resolution and both are per-tool. Per-server capability narrowing
  therefore constrains what the whole `mcp` tool may do, and the per-server distinction is
  carried by this grammar instead.
- `Mcp(metadata)` is a single global grant. A user who allows it can search every configured
  server's cached tool list. That is the intended scope, since the cache holds only names,
  descriptions, and input schemas that the servers publish to any client.
