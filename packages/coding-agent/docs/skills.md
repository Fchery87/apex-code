> Apex Code can create skills. Ask it to build one for your use case.

# Skills

Skills give Pi specialized instructions and supporting files for a particular kind of work. Pi advertises each available skill by name and description, then loads its full instructions only when the task calls for them.

Apex Code implements the [Agent Skills standard](https://agentskills.io/specification), warning about most violations but remaining lenient. Apex Code allows skill names to differ from their parent directory even though the standard disallows it; that rule is suboptimal for shared skill directories used across multiple agent harnesses.

Pi implements the [Agent Skills specification](https://agentskills.io/specification). Most invalid fields produce warnings rather than stopping startup.

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Finding a Skill: skill_search](#finding-a-skill-skill_search)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

A skill is a directory containing `SKILL.md`:

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Apex Code loads skills from:

- Global:
  - `~/.apex-code/agent/skills/`
  - `~/.agents/skills/`
- Project (only after the project is trusted):
  - `.apex-code/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json` (`pi` is Apex Code's retained package-manifest key)
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

> **Isolation note:** skills are read from these roots on the host, with no projection
> or remapping in between (see [Security](security.md#permissions-and-isolation)). If you
> run Apex Code inside a container, a global skill root only exists in the session when
> you mount it, and a skill runs with whatever access that environment grants.

Discovery rules:
- In `~/.apex-code/agent/skills/` and `.apex-code/skills/`, direct root `.md` files are discovered as individual skills when they have valid skill frontmatter with a non-empty `description`
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored, but nested `.md` files in grouping folders are discovered when they declare skill frontmatter
- Root Markdown files other than `SKILL.md` that do not look like skills are ignored silently

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.apex-code/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Apex Code scans skill locations and extracts names and descriptions
2. The system prompt lists available skill **names only**, alphabetically, up to a fixed
   token budget — not the older per-skill XML block with description and location
   inline. A library too large to list in full states how many names were left out and
   points at `skill_search`
3. When a name looks relevant, the agent calls `skill_search` to read that skill's
   description before committing to it
4. The agent uses `read`, or `bash` when `read` is not enabled, to load the full
   SKILL.md (models don't always do this on their own; use prompting or
   `/skill:name` to force it)
5. The agent follows the instructions, using relative paths to reference scripts and
   assets

This is progressive disclosure taken one step further than the base
[specification](https://agentskills.io/integrate-skills): names are always in context,
descriptions load on demand through `skill_search`, and full instructions load on
demand through `read`. A large personal or team skill library costs a small, bounded
amount of context regardless of how many skills it holds — installing more skills
never grows the fixed cost every turn already pays.

## Finding a Skill: skill_search

`skill_search` answers two questions: what skills exist, and what does a specific one
do.

```
skill_search()                 # every loaded skill name, alphabetically
skill_search(query: "browser") # names and descriptions matching "browser"
```

Called with no `query`, it lists every loaded skill's name — useful when the prompt
said "use skill X" but X isn't in the always-visible catalog because the library
exceeded the budget. Called with a `query`, it matches case-insensitively against both
name and description and returns the matches' descriptions, so the agent can decide
whether a skill actually fits before spending a `read` on it. A query that matches
nothing returns an empty list, not an error.

The tool reads only the already-loaded skill registry — no filesystem or network
access — so it carries no permission prompt and needs no confirmation.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

The command token is derived from the skill's `name`, lowercased with runs of
anything other than `a-z0-9-` collapsed to a single hyphen. For a name that already
follows the [Name Rules](#name-rules) below, the token is identical to the name. For a
name the [Validation](#validation) section's leniency let through with spaces or
capitals — `Poteto Mode`, say — the command becomes `/skill:poteto-mode`, not
`/skill:Poteto Mode`, since a slash command cannot contain whitespace. The skill still
loads under its original name for display and for the catalog; only the typed command
differs.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

Start `SKILL.md` with frontmatter followed by direct instructions:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Unlike the standard, Apex Code does not require this to match the parent directory because that standard requirement is suboptimal for shared skill directories. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
Apex Code does not require the name to match the parent directory. The Agent Skills standard does, but that requirement is suboptimal for shared skill directories used by multiple tools.

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Apex Code validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

Declared skills with missing descriptions are not loaded. Malformed `SKILL.md` files and `SKILL.md` files without a description produce warnings and are not loaded. Other Markdown files without valid skill frontmatter are ignored.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

The description determines when the model considers loading the skill. State both what the skill does and when it applies. Avoid descriptions such as “Helps with PDFs,” which do not provide enough routing information.

Use relative paths from the skill directory when referring to bundled files. Pi tells the model where the skill lives so it can resolve those paths.

## Understand how skills load

At startup, Pi scans configured skill locations and adds each skill’s name, description, and path to the system prompt. It does not add the full instructions.

When a task matches, the model reads `SKILL.md` and follows its instructions. This keeps detailed guidance out of context until it is needed. A model might fail to load a relevant skill, so use `/skill:name` when you need to force it.

Arguments after `/skill:name` are appended to the loaded instructions as a user request:

```text
/skill:pdf-tools extract report.pdf
```

Set `disable-model-invocation: true` in frontmatter when a skill should be available only through its explicit command. The `enableSkillCommands` [setting](settings.md) controls whether skill commands appear in interactive command discovery; manually entered `/skill:name` commands still work.

<a id="choose-where-it-loads"></a>

## Add it to Pi

Place the skill in your user or project skills directory. Directories containing `SKILL.md` are discovered recursively.

Pi also supports the Agent Skills locations `~/.agents/skills/` and `.agents/skills/`. Project `.agents/skills/` directories are discovered from the working directory through its ancestors, stopping at the repository root when one exists.

Pi accepts some standalone Markdown skills, but a directory containing `SKILL.md` is the portable form and should be preferred. See [Settings](settings.md#resources) and [Pi Packages](packages.md) for additional locations.

Project skills can instruct the model to run scripts or modify files. Review unfamiliar skills and their supporting files before granting project trust.

## Write portable frontmatter

The Agent Skills specification defines these fields:

| Field | Purpose |
|---|---|
| `name` | Command and display name |
| `description` | Routing description shown to the model |
| `license` | License name or bundled license file |
| `compatibility` | Environment requirements |
| `metadata` | Additional key-value metadata |
| `allowed-tools` | Experimental pre-approved tool list |
| `disable-model-invocation` | Hide the skill from automatic model selection |

Names use lowercase letters, numbers, and hyphens, with no leading, trailing, or consecutive hyphens. They can contain at most 64 characters; descriptions can contain at most 1024.

Pi neither requires nor warns when the declared name differs from the parent directory. Other Agent Skills implementations may enforce that requirement, so matching names remain the portable choice.

Malformed `SKILL.md` files and declared skills without descriptions are not loaded. Name collisions keep the first discovered skill and produce a warning.

## Validate and share a skill

Run Pi from a location where the skill is discoverable, then inspect the startup diagnostics and `/skill:name` command. Run `/reload` after editing a skill during an active session.

Use a [Pi package](packages.md) to distribute one or more skills through npm or git. Keep environment setup inside the skill and declare any required runtime dependencies in the package.

For examples, see the [Anthropic skills collection](https://github.com/anthropics/skills) and [Pi skills collection](https://github.com/badlogic/pi-skills).
