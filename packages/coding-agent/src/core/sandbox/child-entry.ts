import { APP_NAME } from "../../config.ts";
import { main } from "../../main.ts";
import { setApexEnvironment } from "../environment.ts";
import { configureHttpDispatcher } from "../http-dispatcher.ts";
import { installSandboxNetworkRefusalMessages } from "./network-refusal.ts";

process.title = APP_NAME;
setApexEnvironment("APEX_CODE_CODING_AGENT", "true");
process.env.AI_AGENT = "apex-code";
process.emitWarning = (() => {}) as typeof process.emitWarning;
configureHttpDispatcher();
// Only the sandboxed child installs this, which is what makes attributing a refused
// request to the sandbox allowlist accurate rather than a guess about whose proxy replied.
installSandboxNetworkRefusalMessages();

await main(process.argv.slice(2), { sessionLeaseOwner: "supervisor" });
