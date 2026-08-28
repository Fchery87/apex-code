> Apex Code can help you create Apex Code packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Apex Code Packages

Apex Code packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the `pi` key (Apex Code's retained package-manifest key), or use conventional directories.

## Table of Contents

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

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
apex-code -e npm:@foo/bar
apex-code -e git:github.com/user/repo
```

## Package Sources

Apex Code accepts three source types in settings and `apex-code install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`apex-code update --extensions`, `apex-code update --all`).
- User installs go under `~/.apex-code/agent/npm/`.
- Project installs go under `.apex-code/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

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
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`. Positive manifest globs discover visible paths in lexical order. List dot-prefixed paths directly. If a glob would need to continue through a symlink, list the symlinked resource root directly.

### Gallery Metadata

Apex Code does not operate or depend on a hosted package gallery (see ADR 0013). The
`video`/`image` fields below are retained upstream vocabulary from Pi's own package
gallery, kept for cross-compatibility if you publish the same package to both
ecosystems — they have no effect within Apex Code itself. Add them to show a preview
there:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

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
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `apex-code config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `apex-code config` starts in global settings (`~/.apex-code/agent/settings.json`); press Tab to switch between global and project-local modes. Use `apex-code config -l` to start in project overrides (`.apex-code/settings.json`) with inherited global resources dimmed.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
