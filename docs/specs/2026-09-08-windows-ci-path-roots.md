# Windows prepared paths and CI coverage

**Status:** Active

**Date:** 2026-09-08

## Problem

Windows CI run 34192650477 reports eleven failures across eight coding-agent test
files. Restoring the original scratch-directory setup in two files in run
34193896372 reproduces all eleven failures and reintroduces three macOS failures.
The canonical scratch helpers remain necessary.

Prepared path execution splits a Windows drive root into a directory component.
From a checkout on D:, execution of a C: target attempts to open or create
`D:\C:`. Formatter promotion uses the same prepared write boundary.

## Behavior

Prepared reads and writes begin at the absolute path's parsed filesystem root.
Only the remaining directory components are walked. Drive roots, UNC share roots,
and namespaced Windows drive roots remain intact. Existing descriptor identity checks,
exclusive creation, and no-follow flags remain in place. ADR 0029's platform
limitations continue to apply.

Sandbox tests must distinguish portable lifecycle behavior from POSIX mode and
no-follow guarantees. Any Windows exclusions require evidence that the tested
supervisor behavior is outside the supported Windows execution path. Windows
fail-closed sandbox selection remains tested.

## Verification

Exercise the public prepared-read and prepared-write functions with Windows path
semantics and real files in an isolated temporary directory. Observe the new
regression tests fail before changing execution. Run the narrow affected suites,
the type check, the full test command, and three-platform CI. CI must confirm
formatter and delegation recovery rather than inferring it from the shared caller.

## Deletion inventory

Remove the root-unaware component splitter if parsing the root makes it obsolete.
No public API or security check is removed.
