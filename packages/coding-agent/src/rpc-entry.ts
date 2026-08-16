#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { setApexEnvironment } from "./core/environment.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
setApexEnvironment("APEX_CODE_CODING_AGENT", "true");
process.env.AI_AGENT = "apex-code";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
