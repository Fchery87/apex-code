# RS.8 / RS.9 actual terminal verification

The root drove the source CLI through a recorded PTY with the offline public provider fixture. All session, settings and evidence state lives in /tmp/apex-rs8-terminal-7ab0i3m4. No model request or credential was used.

rs8-cli.log records an explicit read,bash,edit,write,todo_write session. The start prompt rendered Task list updated · 1/6 complete and Tasks 1/6 · Implement task panel. Escape+j expanded five items plus +1 more. /tasks restored the count row. The complete prompt rendered 6/6 in the tool cell and removed the pinned panel after settlement. Two Ctrl+O presses selected all detail and disclosed six rows in each result cell. Clear produced 0/0 and no pinned panel.

/settings filtered to Task-list tool. The disabled row explained new-session behavior. Enter enabled it; scratch settings.json contained exactly read,bash,edit,write,todo_write. rs9-cli-new-session.log records a fresh source CLI without --tools successfully executing todo_write and displaying the panel. Escape+j persisted taskPanelExpanded true.

rs8-cli-resume.log records session 01a104f5-3862-72fc-990a-1204a9aeacb7 resumed without --tools. The initial rendered panel reconstructed five rows plus overflow. Disabling the settings row saved exactly read,bash,edit,write while the current expanded panel remained rendered. Ctrl+D exited each session cleanly. The resumed process required one Enter before its initial output was returned; no source change was inferred from that transport observation.

Mouse disclosure, branch navigation, compaction, configured-service defaults, project read-only state and CLI restrictions are covered by focused public-boundary tests rather than this terminal transcript. Performance and full gates are recorded separately.
