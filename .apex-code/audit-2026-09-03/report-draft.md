# Apex Code security and execution audit

## Scope and verdict

Requested reference date: September 3, 2026. Audited checkout: `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`, committed September 4. The forked application source is identical to `49e1f18efcf3dcbb130c4b108d9606fb3e0404a6`, the last commit before September 4 in the repository's local timezone. Tests and documentation differ. Public documentation retrieved during this audit is date-qualified separately.

This is a read-only audit, not a repair or a security certification. Application code was not changed. Scratch scripts, reports, and output are under `.apex-code/audit-2026-09-03/`. No prohibited source tree was accessed.

## Architecture

Project trust decides whether project configuration and executable resources may load. Tool permission rules decide whether a proposed tool call may execute. The OS sandbox constrains the resulting process tree. These are separate controls. None substitutes for the others.

The normal CLI launches a supervisor, constructs a Linux Bubblewrap or macOS Seatbelt child, and starts the agent inside that child. A registry-owned tool contract supplies permission grammar and capabilities. The session's `beforeToolCall` hook evaluates the permission store and mode. Missing approval responders and unreadable rule sources fail closed at that gate. The supervisor also provides network, credential, and command-escalation channels. These channels accept requests from sandbox descendants and therefore require their own authorization and safe host execution.

Relevant owners:

- `packages/coding-agent/src/cli.ts` owns the normal supervisor entry.
- `packages/coding-agent/src/main.ts` builds the live rule store and session runtime.
- `packages/coding-agent/src/core/permissions/` owns rule parsing, precedence, modes, and approval.
- `packages/coding-agent/src/core/sandbox/` owns OS policies and supervisor channels.
- `packages/coding-agent/src/core/sdk.ts` owns programmatic session construction.

## Review method

Four independent review partitions covered permission enforcement, sandbox supervision, alternate execution paths, and public product documentation. The root reviewer inspected the important source paths and retained reproduction artifacts. Findings distinguish executed probes from static analysis and documented limitations. Existing test success is evidence about covered cases, not proof that missing adversarial cases are safe.
