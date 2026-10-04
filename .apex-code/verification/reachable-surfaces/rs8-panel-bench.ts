// Run from repo root: npx tsx --tsconfig tsconfig.runtime.json .apex-code/verification/reachable-surfaces/rs8-panel-bench.ts
// --smoke exercises two frames per case; its timings are not performance evidence.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text, TuiAltScreen, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { AuthStorage } from "../../../packages/coding-agent/src/core/auth-storage.ts";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.ts";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.ts";
import { createChatViewport } from "../../../packages/coding-agent/src/modes/interactive/chat-viewport.ts";
import { AssistantMessageComponent } from "../../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts";
import { ComposerDock } from "../../../packages/coding-agent/src/modes/interactive/components/composer-dock.ts";
import { CustomEditor } from "../../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { createMermaidMarkdownTransformer } from "../../../packages/coding-agent/src/modes/interactive/components/mermaid.ts";
import { TaskPanelComponent } from "../../../packages/coding-agent/src/modes/interactive/components/task-panel.ts";
import { getEditorTheme, initTheme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

class NullTerminal implements Terminal {
 columns = 100; rows = 30; kittyProtocolActive = true;
 start(): void {} stop(): void {} async drainInput(): Promise<void> {}
 write(_data: string): void {} moveBy(_lines: number): void {}
 hideCursor(): void {} showCursor(): void {} clearLine(): void {}
 clearFromCursor(): void {} clearScreen(): void {} setTitle(_title: string): void {}
 setProgress(_active: boolean): void {}
}

const smoke = process.argv.includes("--smoke");
const frames = smoke ? 2 : 80;
const branchSize = smoke ? 40 : 6_000;
const histories = smoke ? [20] : [20, 100, 300];
const transcriptText = ("The renderer keeps up with **streaming text** and `code` while task chrome stays fixed. ".repeat(8) + "\n\n").repeat(6);
function message(text: string): AssistantMessage {
 return { role: "assistant", content: [{type: "text", text}], api: "openai-completions", provider: "probe", model: "probe", timestamp: 0,
  stopReason: "stop", usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}} };
}
const todos = Array.from({length: 12}, (_, i) => ({content: `Task ${i + 1}: bounded task panel workload`, status: i === 4 ? "in_progress" : i < 4 ? "completed" : "pending"}));
const previousCwd = process.cwd();
const previousAgentDir = process.env.APEX_CODE_CODING_AGENT_DIR;
const scratch = mkdtempSync(join(tmpdir(), "apex-rs8-panel-bench-"));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir);
process.chdir(scratch);
process.env.APEX_CODE_CODING_AGENT_DIR = agentDir;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
 initTheme("dark");
 const settings = SettingsManager.inMemory();
 const manager = SessionManager.inMemory(scratch);
 for (let i = 0; i < branchSize; i++) manager.appendCustomEntry("benchmark_history", {index: i, text: "history"});
 manager.appendCustomEntry("todo", todos);
 const runtime = await ModelRuntime.create({credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false});
 const faux = fauxProvider({provider: "rs8-benchmark"});
 runtime.registerNativeProvider(faux.provider);
 await runtime.refresh({allowNetwork: false, providers: [faux.getModel().provider]});
 const resources = new DefaultResourceLoader({cwd: scratch, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
 await resources.reload();
 ({session} = await createAgentSession({cwd: scratch, agentDir, settingsManager: settings, sessionManager: manager, modelRuntime: runtime, model: faux.getModel(), tools: ["todo_write"], resourceLoader: resources, evidenceSink: {record: () => {}}}));
 const liveSession = session;
 let branchCalls = 0;
 const originalGetBranch = manager.getBranch.bind(manager);
 manager.getBranch = (...args: Parameters<SessionManager["getBranch"]>) => {branchCalls++; return originalGetBranch(...args);};
 console.log(JSON.stringify({kind: "configuration", smoke, frames, branchEntries: manager.getEntries().length, histories, columns: 100, rows: 30, note: "absent omits panel; off mounts panel with todo_write inactive. Timings include updateContent and full renderNow; no disk append or model request."}));
 for (const history of histories) for (const layout of ["main", "fullscreen"] as const) for (const state of ["absent", "off", "collapsed", "expanded"] as const) {
  liveSession.setActiveToolsByName(state === "off" ? [] : ["todo_write"]);
  settings.setTaskPanelExpanded(state === "expanded");
  const panel = new TaskPanelComponent({getSession: () => liveSession, getSettings: () => settings});
  const widgets = new Container();
  if (state !== "absent") widgets.addChild(panel);
  widgets.addChild(new Text("Extension widget", 0, 0));
  const terminal = new NullTerminal();
  const tui = layout === "main" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const document = new Container();
  for (let i = 0; i < history; i++) document.addChild(i % 2 ? new AssistantMessageComponent(message(transcriptText.slice(0, 1_500))) : new Text(`User question ${i}: deterministic transcript history.`, 1, 0));
  const streaming = new AssistantMessageComponent(undefined, false, undefined, undefined, 1, [createMermaidMarkdownTransformer({getMode: () => "off"})]);
  document.addChild(streaming);
  const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
  editor.setText("Continue the task");
  const composer = new ComposerDock(() => editor);
  composer.addChild(editor);
  const pending = new Container(); const status = new Container(); const below = new Container();
  const footer = new Text("probe · task benchmark", 0, 0);
  if (tui instanceof TuiAltScreen) tui.setLayoutRoot(createChatViewport({document, pendingMessages: pending, status, widgetsAbove: widgets, editor: composer, widgetsBelow: below, footer}).root);
  else for (const child of [document, pending, status, widgets, composer, below, footer]) tui.addChild(child);
  tui.setFocus(editor);
  branchCalls = 0;
  tui.start();
  try {
   tui.renderNow();
   const initialReads = branchCalls;
   for (let i = 1; i <= (smoke ? 1 : 8); i++) {streaming.updateContent(message(transcriptText.slice(0, i * 50)), true); tui.renderNow();}
   branchCalls = 0;
   let maxPanelRows = 0;
   const samples: number[] = [];
   for (let i = 1; i <= frames; i++) {
    const start = performance.now();
    streaming.updateContent(message(transcriptText.slice(0, Math.floor(transcriptText.length * i / frames))), true);
    tui.renderNow();
    samples.push(performance.now() - start);
    if (state !== "absent") maxPanelRows = Math.max(maxPanelRows, panel.render(100).length);
   }
   const steadyReads = branchCalls;
   assert.equal(steadyReads, 0, "unchanged-leaf streaming must not scan branch");
   assert.equal(initialReads, state === "absent" ? 0 : 1, "one initial snapshot scan");
   assert.equal(maxPanelRows, state === "expanded" ? 6 : state === "collapsed" ? 1 : 0);
   manager.appendCustomEntry("todo", [{content: "Fresh replacement snapshot", status: "in_progress"}]);
   branchCalls = 0;
   const refreshStart = performance.now();
   const refreshed = state === "absent" ? [] : panel.render(100);
   const snapshotMs = performance.now() - refreshStart;
   assert.equal(branchCalls, state === "absent" ? 0 : 1, "one scan after leaf changes");
   if (state === "collapsed" || state === "expanded") assert.ok(refreshed.join("\n").includes("Fresh replacement snapshot"));
   samples.sort((a, b) => a - b);
   console.log(JSON.stringify({history, layout, state, frames, meanMs: +(samples.reduce((a,b) => a+b,0)/samples.length).toFixed(3), p95Ms: +samples[Math.floor(samples.length * .95)].toFixed(3), over16MsPercent: +(100*samples.filter(value => value > 16).length/samples.length).toFixed(1), maxPanelRows, initialBranchReads: initialReads, steadyBranchReads: steadyReads, refreshBranchReads: branchCalls, snapshotMs: +snapshotMs.toFixed(3)}));
  } finally {tui.stop(); manager.appendCustomEntry("todo", todos);}
 }
} finally {
 session?.dispose();
 process.chdir(previousCwd);
 if (previousAgentDir === undefined) delete process.env.APEX_CODE_CODING_AGENT_DIR;
 else process.env.APEX_CODE_CODING_AGENT_DIR = previousAgentDir;
 rmSync(scratch, {recursive: true, force: true});
}
