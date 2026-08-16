import { APP_NAME } from "../../config.ts";
import { main } from "../../main.ts";
import { setApexEnvironment } from "../environment.ts";
import { configureHttpDispatcher } from "../http-dispatcher.ts";

process.title = APP_NAME;
setApexEnvironment("APEX_CODE_CODING_AGENT", "true");
process.env.AI_AGENT = "apex-code";
process.emitWarning = (() => {}) as typeof process.emitWarning;
configureHttpDispatcher();

await main(process.argv.slice(2));
