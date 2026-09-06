import {requiresSandboxedChild} from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/cli-launch.ts";
import {parseArgs} from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/cli/args.ts";
for (const args of [['--append-system-prompt','--help','--mode','rpc'],['--system-prompt','--version','--mode','rpc']]) { const parsed=parseArgs(args); console.log(JSON.stringify({args,requiresSandboxedChild:requiresSandboxedChild(args),parsed})); }
