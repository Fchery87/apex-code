# ADR 0021 — The skill catalog is name-only and budget-bounded; descriptions resolve through a model-callable tool

**Status:** Accepted · **Date:** 2026-08-20

## Decision

Apex Code announces skills to the model by **name only**, inside a fixed token budget,
and resolves a skill's description through an explicit, model-callable `skill_search`
tool. Skill **content** continues to load through the existing `read` tool, unchanged.

The static prompt prefix carries an alphabetically ordered list of skill names, added
until `SKILL_CATALOG_PREFIX_BUDGET_TOKENS` is spent. When the budget is exhausted, the
prefix states how many skills were omitted and directs the model to `skill_search`. The
catalog's contribution to the prefix is therefore bounded by construction and does not
vary with the size of the user's skill library.

`skill_search` accepts an optional query. With no query it returns skill names. With a
query it returns matching names and their descriptions. It reads the same in-memory
skill registry the prefix is built from. It performs no filesystem or network I/O, holds
no capabilities, defaults to `allow`, is not evictable, emits no evidence, and does not
defer its own schema.

This extends `ADR 0011` from tool schemas to skill descriptions. It does not revisit
ADR 0011's decision for tools.

## Why this shape

The full catalog does not fit and cannot be made to fit by trimming. Measured against a
real 115-skill library, of which 60 are model-visible:

| Projection | Prefix cost |
| --- | --- |
| Name and full description (current code) | 6,742 tokens |
| Name and description truncated to 160 characters | 3,408 tokens |
| Name and description truncated to 80 characters | 2,277 tokens |
| Name only | 486 tokens |

The enforced budget is 2,500 tokens against a measured floor of 2,372, so the available
headroom is 128 tokens. Every projection that retains descriptions exceeds the entire
current prefix before it is added to it. Truncation is not a smaller version of the
problem; an 80-character cut still costs 18 times the headroom, and 80 characters is
below the median description length of 329, so it truncates almost every entry into
uselessness. Descriptions are 22,623 of the 26,753 raw bytes. Names are 865.

**The budget must bound the catalog, not the count.** Skill names cost about 8.1 tokens
each. A library of 300 skills costs roughly 2,430 tokens in names alone. Unlike every
other prefix contributor, the skill catalog is sized by user data rather than by the
product. A fixed ceiling in a test cannot guard a quantity the user chooses, and a
count cap still varies with name length. Only an explicit token budget makes the
contribution provable, which is why the budget is the primitive and the count is a
consequence.

**Names are retained because search alone is not discovery.** ADR 0011 kept tool names
and descriptions in the prefix precisely so the model could find a tool it had not been
told about. A pure-search catalog would require the model to guess query terms for a
library whose existence it cannot see, and would make skills invisible on exactly the
turns where they are useful. Retaining names preserves recognition; deferring
descriptions removes the cost. Skill names are unusually good discovery surfaces
compared with tool names, because a skill is named for its task.

**ADR 0011 anticipated this case and declined it for tools.** It rejected "schema search
over tool names" as "unnecessary for this phase," and stated that search "can be added
later if a measured tool surface needs it." The skill surface is four times the tool
count, is chosen by the user rather than the product, and is now measured. This is the
condition that ADR 0011 named.

**One tool rather than three.** A separate list, info, and search trio would each need a
contract, a permission story, and a test. `skill_search` with an optional query covers
listing, lookup by exact name, and discovery by topic. The common path, where the model
sees a name in the prefix and wants to know whether it applies, is a query for that
name.

**Content stays on `read`.** The current system prompt already instructs the model to
read a skill's file, and `read` is already permission-gated, already evictable, and
already emits evidence. Giving `skill_search` a content mode would add a second file
read path with a different permission surface for no benefit. This is why the tool holds
no capabilities: it answers only from the registry the harness already built.

## Consequences

- A skill the model has not used before costs one extra turn: `skill_search`, then
  `read`, then the work. This is ADR 0011's accepted trade, applied to a larger surface.
- Skill **descriptions become operationally load-bearing for search quality** rather than
  for prefix recognition. A skill with a vague description is now hard to find rather
  than merely expensive.
- Skill **names become the primary discovery surface** and should read as task names. The
  Agent Skills naming rules already push in this direction.
- The prefix budget rises once, by a measured amount, to accommodate the bounded
  catalog. It does not rise again when a user installs more skills.
- Users with libraries larger than the budget see a truncated catalog and depend on
  search. The omitted count is stated in the prefix rather than hidden.
- `formatSkillsForPrompt`'s current output shape is replaced. Its description and
  location fields no longer appear in the prefix.
- The replay corpus gains a determinism obligation: catalog order must be stable, so the
  listing is ordered alphabetically rather than by discovery order.

## Rejected alternatives

- **Keep the full catalog and raise the budget.** Rejected because the budget would then
  be set by the user's skill library rather than by the product, which makes the gate
  meaningless and lets one user's install degrade a shared measurement.
- **Truncate descriptions.** Rejected on the measurement. The cheapest useful truncation
  costs more than the entire current prefix, and cuts below the median description
  length.
- **Leave model-visible injection off and ship only slash commands.** Rejected because it
  is not a design, it is the absence of one, and it permanently forfeits a capability
  every comparable harness ships. It was this spec's first proposal and the measurement
  above is what replaced it.
- **Pure search with no catalog.** Rejected because the model cannot query for what it
  cannot see, and ADR 0011 already reasoned through why retained names matter.
- **Per-skill opt-in via frontmatter.** Rejected because `disable-model-invocation`
  already exists for the inverse, and making visibility opt-in would silently hide
  existing libraries.
- **A content mode on `skill_search`.** Rejected because it duplicates `read` with a
  weaker permission surface.
