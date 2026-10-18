// Owner process for the SIGKILL recovery test. It journals one background command, starts it,
// reports readiness, and then waits to be killed.
import { spawn } from "node:child_process";
import { createCommandJournalRecorder } from "../../../src/core/durable-state/command-journal.ts";
import { createBackgroundShellRegistry } from "../../../src/core/tools/background-shell.ts";
import { OutputAccumulator } from "../../../src/core/tools/output-accumulator.ts";

const databasePath = process.argv[2]!;
const recorder = createCommandJournalRecorder(databasePath, "session-kill");
const registry = createBackgroundShellRegistry({ journal: recorder });
const journalId = registry.beginJournal("long-running");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
registry.launch({ command: "long-running", pid: child.pid, output: new OutputAccumulator(), exited, journalId });
process.stdout.write(`${JSON.stringify({ ready: true, journalId, childPid: child.pid })}\n`);
setInterval(() => {}, 1_000);
