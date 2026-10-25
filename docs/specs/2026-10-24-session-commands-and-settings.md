# Session commands and settings

**Status:** Active

The October 24 command and settings audit compared Apex with the current command references for Codex CLI, Claude Code, OpenCode, and Gemini CLI. Four gaps were worth building. The rest of those products' commands are product-specific or decoration, and this spec does not add them.

## /diff

`/diff` prints the working tree. It runs `git status --short` and `git diff HEAD`, includes untracked files by listing them, and caps the diff at 200 lines with a count of what was omitted. Outside a git repository it says so and prints nothing else. It never writes, stages, or stashes.

## Aliases

`/config` opens the settings menu. The configuration index duplicated `/model`, `/login`, `/logout`, `/trust`, and `/resources`, each of which already has its own command.

`/clone` does what `/fork` does at the current position: it opens the message selector. One command owns branching the session.

## /context

`/context` prints the context window used, the cache hit rate, the cost, and the largest contributors it can name from the session. `/session` stays for the file path, id, and message counts. The two do not repeat each other's numbers.

## Settings

The settings menu splits into Session, Appearance, and Advanced pages. Checkpoints, the run budget, and bash confinement get a row each. Checkpoints and the run budget already have runtime behavior. Bash confinement stays off unless the user turns it on, and the row says that a missing helper refuses the call.

## /rewind

`/rewind` lists the session's checkpoints and restores the one the user picks. The checkpoint engine already saves the pre-restore state, so a second `/rewind` returns to it. With no checkpoints it says none exist. It does not restore the conversation. That needs its own design and is out of scope.

## Deletion inventory

Nothing is deleted. `/config` and `/clone` remain as names and change what they open.
