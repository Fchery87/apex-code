**Status:** Active

# Composer dock surface implementation plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Give Apex Code's built-in prompt editor the filled, padded dock surface already specified by the terminal-interaction-polish work.

**Architecture:** Extend `CustomEditor` with one optional surface renderer. It paints only the editor border and content rows after the inherited editor has completed its width-sensitive layout. `InteractiveMode` passes the existing `userMessageBg` token to the built-in editor. Autocomplete and replacement components remain outside the surface.

**Tech stack:** TypeScript, Vitest, public `@earendil-works/pi-tui` APIs, ANSI terminal output.

## Task table

| Task | Status | Commit |
| --- | --- | --- |
| CDS.1 | Not started | — |
| CDS.2 | Not started | — |
| CDS.3 | Not started | — |

### CDS.1: Prove the dock surface boundary

**Files:**

- Modify: `packages/coding-agent/test/custom-editor-chrome.test.ts`
- Read: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`

1. Add failing tests for a full-width surface, one blank surface row above and below the editor, cursor-safe background resumption, autocomplete separation, and the existing narrow-width matrix.
2. Run `npm --workspace packages/coding-agent test -- custom-editor-chrome.test.ts`.
3. Confirm the new tests fail because `CustomEditor` does not expose or render a surface.
4. Record the real failure in the task table when the implementation commit lands.

### CDS.2: Render the Apex-owned composer surface

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Test: `packages/coding-agent/test/custom-editor-chrome.test.ts`

1. Add the minimum typed option needed to paint the default editor surface.
2. Render the base editor at the safe reduced width, then paint only its bordered editor block with one-cell outer padding.
3. Preserve ANSI control sequences and leave autocomplete unpainted.
4. Pass `theme.bg("userMessageBg", text)` from the built-in editor construction only.
5. Run the focused test file until it passes.
6. Commit the implementation and update CDS.1 and CDS.2 with the verified SHA.

### CDS.3: Verify the actual terminal artifact

**Files:**

- Modify: `docs/specs/2026-08-23-composer-dock-surface.md`
- Modify: `docs/roadmap.md`
- Delete: `docs/plans/2026-08-23-composer-dock-surface.md` after completion

1. Run `npm run check`.
2. Run `npm --workspace packages/coding-agent test`.
3. Run `npm test`.
4. Run the Impeccable detector over the changed UI files.
5. Start the local executable and inspect the bottom dock in a fresh session.
6. Confirm `git diff -- packages/tui` is empty.
7. Update the spec and roadmap with real verification results. Delete this completed plan in the same commit and record its SHA in the durable documents.

## Throughput checkpoint

After CDS.2 passes, inspect one real render before the broad suites. If the visible prompt surface or cursor is wrong, stop and repair that boundary before starting CDS.3.
