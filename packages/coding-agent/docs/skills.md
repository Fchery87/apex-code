> Apex Code can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Apex Code implements the [Agent Skills standard](https://agentskills.io/specification), warning about most violations but remaining lenient. Apex Code allows skill names to differ from their parent directory even though the standard disallows it; that rule is suboptimal for shared skill directories used across multiple agent harnesses.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Finding a Skill: skill_search](#finding-a-skill-skill_search)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

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

> **Sandbox note:** every session runs inside Apex Code's OS sandbox (see
> [Security](security.md#os-sandbox-and-permissions)), which hides your home
> directory from the child process by default. The two global roots above are
> mounted back in, read-only, at their original host paths, so they work the same as
> everywhere else. Project skills already work without a mount, since the workspace
> itself is mounted read-write. Packages, settings, and `--skill` paths follow
> whichever of these roots they resolve under.

Discovery rules:
- In `~/.apex-code/agent/skills/` and `.apex-code/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

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
4. The agent uses `read` to load the full SKILL.md (models don't always do this on
   their own; use prompting or `/skill:name` to force it)
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

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

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

**Exception:** Skills with missing description are not loaded.

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
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
