# Sessions and Context

Apex Code saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Continue or switch sessions

Sessions auto-save to `~/.apex-code/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure.

```bash
apex-code -c                  # Continue most recent session
apex-code -r                  # Browse and select from past sessions
apex-code --no-session        # Ephemeral mode; do not save
apex-code --name "my task"    # Set session display name at startup
apex-code --session <path|id> # Use a specific session file or partial session ID
apex-code --fork <path|id>    # Fork a session file or partial session ID into a new session
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Choose how to branch

Apex Code stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

`/resume` opens an interactive session picker for the current project. `apex-code -r` opens the same picker at startup.

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, Apex Code can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

When available, Apex Code uses the `trash` CLI for deletion instead of permanently removing files.

## Manage conversation context

The model receives the active branch, not every branch in the session file. Apex Code combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How Apex Code Works](how-pi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, Apex Code normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

```bash
apex-code --name "Refactor auth module"
apex-code --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `apex-code -r`.

## Control session storage

By default, Apex Code stores sessions under `~/.apex-code/agent/sessions/`, grouped by working directory. Use `--session-dir`, `APEX_CODE_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after Apex Code exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. `/share` asks before uploading the complete HTML session to an unlisted GitHub Gist. It returns the Gist URL and adds a preview link only when `APEX_CODE_SHARE_VIEWER_URL` names a viewer.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a local ZIP report. Apex Code does not upload bug reports. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, Apex Code can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Reporting Bugs

`/bug [description]` writes a ZIP archive in the current directory. The dialog asks whether to include the session transcript. If you decline, Apex Code can ask the current model to summarize the problem; that sends the conversation to your configured provider, and only the summary is attached to the archive.

Both contain the same files:

| File | Content |
|------|---------|
| `report.json` | Apex Code version, runtime, OS, terminal, current model and provider configuration, loaded extensions, and settings. API keys, header values, URL credentials, and the analytics tracking id are never included. |
| `diagnostics.json` | Provider and runtime error diagnostics attached to assistant messages across the whole session (failed or aborted turns, retries, error messages), plus any recorded crashes. Always included; message content is not. |
| `session.jsonl` | The current branch of the session, only when you chose to include it. It contains file contents and command output read during the session. |
| `summary.md` | The model-written summary, only when you chose to generate one. |

Each report has a UUID. Apex Code shows it after export and records it in the session as an `apex-code.bug-report` entry.

### Crashes

When Apex Code exits because of an uncaught exception or fatal runtime error, it stores the error message and stack trace in `~/.apex-code/agent/crashes.json` (the newest five). The next interactive start shows a warning once; running `/bug` can include stored crashes in the local ZIP export. Resume the crashed session with `apex-code -r` first if you want the transcript in the report.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
