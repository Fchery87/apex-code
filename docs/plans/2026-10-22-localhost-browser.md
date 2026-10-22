# Plan: Localhost browser

**Status:** Live

## Tasks

| Task | State | Commit |
| --- | --- | --- |
| Destination check and its unit tests | done | `08f093658` |
| Tool definition, contract, and injected-operation tests | done | `e42b292e3` |
| Registry opt-in, absent unless configured | done | `e87b588b5` |

## Order

The destination check has no tool dependency, so it lands first. The tool definition calls it and is tested with an injected operation. The registry change is last because it only re-exports a tool that already exists.

A real browser process is not in this plan. The spec defers it until the tool contract and the loopback refusal are in place.

## Order changes

None.
