import { APP_NAME } from "../../config.ts";
import { main } from "../../main.ts";
import { setApexEnvironment } from "../environment.ts";
import { configureHttpDispatcher } from "../http-dispatcher.ts";
import { installSandboxNetworkRefusalMessages } from "./network-refusal.ts";
import { applyTerminalSize, TERMINAL_SIZE_PATH_VARIABLE } from "./terminal-size.ts";

process.title = APP_NAME;
setApexEnvironment("APEX_CODE_CODING_AGENT", "true");
process.env.AI_AGENT = "apex-code";
process.emitWarning = (() => {}) as typeof process.emitWarning;
configureHttpDispatcher();
// Only the sandboxed child installs this, which is what makes attributing a refused
// request to the sandbox allowlist accurate rather than a guess about whose proxy replied.
installSandboxNetworkRefusalMessages();
// bwrap --new-session leaves this process without a controlling terminal, so
// its stdout reports a window size frozen at sandbox creation. The supervisor
// publishes the real one; adopt it before any UI is built.
const terminalSizePath = process.env[TERMINAL_SIZE_PATH_VARIABLE];
if (terminalSizePath) applyTerminalSize(terminalSizePath);

await main(process.argv.slice(2), { sessionLeaseOwner: "supervisor" });
