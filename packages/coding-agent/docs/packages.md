> Apex Code can help you create Apex Code packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Apex Code Packages

Apex Code packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `pi` key (Apex Code's retained package-manifest key), or use conventional directories.

A package is an ordinary directory or npm package. It can expose conventional resource directories, declare explicit paths under the `pi` key in `package.json`, and carry its own runtime dependencies.

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating an Apex Code Package](#creating-an-apex-code-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Apex Code packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
apex-code install npm:@foo/bar@1.0.0
apex-code install git:github.com/user/repo@v1
apex-code install https://github.com/user/repo  # raw URLs work too
apex-code install /absolute/path/to/package
apex-code install ./relative/path/to/package

apex-code remove npm:@foo/bar
apex-code list                     # show installed packages from settings
apex-code update                   # update Apex Code only
apex-code update --all             # update Apex Code, update packages, and reconcile pinned git refs
apex-code update --extensions      # update packages and reconcile pinned git refs only
apex-code update --models          # refresh model catalogs only
apex-code update --self            # update Apex Code only
apex-code update --self --force    # reinstall Apex Code even if current
apex-code update npm:@foo/bar      # update one package
apex-code update --extension npm:@foo/bar
```

These commands manage Apex Code packages and `apex-code update` can update the Apex Code CLI installation. For experimental installer-managed installations, `apex-code update` installs the exact checked version into a staged, lockfile-backed release and activates it only after verification, leaving the current release intact if the update fails. Managed installations do not support `--force`; rerun the installer to repair one. To uninstall Apex Code itself, see [Quickstart](quickstart.md#uninstall).

By default, `install` and `remove` write to user settings (`~/.apex-code/agent/settings.json`). Use `-l` to write to project settings (`.apex-code/settings.json`) instead. Project settings can be shared with your team, and apex-code installs any missing packages automatically on startup after the project is trusted.

Project packages are installed and loaded only after project trust is resolved. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it. Review project package declarations before granting project trust.

Use `--extension` or `-e` to try a package for one invocation without adding it to settings:

```bash
apex-code -e npm:@foo/bar
apex-code -e git:github.com/user/repo
```

## Choose a source

Apex Code accepts three source types in settings and `apex-code install`.

Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates reconcile the checkout but do not move a configured ref.

Relative local paths resolve from the settings file that contains them. A file path loads one extension. A directory follows normal package discovery rules.

## Create a package

The simplest package uses conventional directories:

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

- Versioned specs are pinned and skipped by package updates (`apex-code update --extensions`, `apex-code update --all`).
- User installs go under `~/.apex-code/agent/npm/`.
- Project installs go under `.apex-code/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Use an explicit manifest when resources live elsewhere or need filtering:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `apex-code update --extensions` and `apex-code update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `apex-code install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.apex-code/agent/git/<host>/<path>` (global) or `.apex-code/git/<host>/<path>` (project).
- When reconciliation changes the checkout, Apex Code resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
apex-code install git:git@github.com:user/repo

# ssh:// protocol format
apex-code install ssh://git@github.com/user/repo

# With version ref
apex-code install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, Apex Code loads resources using package rules.

## Creating an Apex Code Package

Add a `pi` manifest to `package.json` or use conventional directories. `pi` is Apex Code's retained package-manifest key (see [Environment compatibility](../README.md#environment-compatibility)). Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Paths are relative to the package root. Arrays accept glob patterns and exclusions. List dot-prefixed or symlinked resource roots directly when traversal through a glob would not discover them.

The `pi-package` keyword is retained package metadata. Apex Code does not operate a hosted package gallery. Optional `pi.image` and `pi.video` fields have no effect within Apex Code.

Apex Code does not operate or depend on a hosted package gallery (see ADR 0013). The
`video`/`image` fields below are retained upstream vocabulary from upstream Pi's package
gallery, kept for cross-compatibility if you publish the same package to both
ecosystems — they have no effect within Apex Code itself. Add them to show a preview
there:

Put runtime packages imported by extensions in `dependencies`. Apex Code installs package dependencies when it installs an npm or git source.

Apex Code supplies these packages to extensions and skills:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Declare imported Apex Code packages in `peerDependencies` with a `"*"` range and do not bundle them. Other Apex Code packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths.

Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package’s undeclared dependency.

If no `pi` manifest is present, Apex Code auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When apex-code installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Apex Code bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `apex-code-agent-core`, `apex-code`, `@earendil-works/pi-tui`, `typebox`.

Other Apex Code packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Apex Code loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    {
      "source": "npm:@example/pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

For each resource type:

- Omit the property to load everything allowed by the package.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude glob matches.
- Use `+path` to include one exact allowed path.
- Use `-path` to exclude one exact path.

Filters narrow the package manifest. They do not expose resources that the package itself did not declare.

Use `apex-code config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `apex-code config` starts in global settings (`~/.apex-code/agent/settings.json`); press Tab to switch between global and project-local modes. Use `apex-code config -l` to start in project overrides (`.apex-code/settings.json`) with inherited global resources dimmed.

## Understand scope and identity

The same package can appear in personal and project settings. A project entry normally replaces the personal entry. With `autoload: false`, the project entry instead acts as a filtering delta over the personal package.

Apex Code identifies npm packages by package name, git packages by repository URL without the ref, and local packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Themes](themes.md) to design each resource before packaging it.
