# Plan: Throwaway Chrome for the browser tool

**Status:** Live

## Tasks

| Task | State | Commit |
| --- | --- | --- |
| DevTools session, tested against a fake socket | not started | |
| Chrome process, tested with a stand-in binary | not started | |
| `browser.enabled` setting wires the process into the session | not started | |

## Order

The session speaks DevTools and does not know how Chrome was started, so it lands first and is tested with a fake socket. The process spawns Chrome, waits for the port, and calls the session. The setting is last because it only passes that process to a session that opted in.

## Order changes

None.
