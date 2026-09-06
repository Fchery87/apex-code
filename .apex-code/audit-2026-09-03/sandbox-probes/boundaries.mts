import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTerminalHandoff } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/terminal-handoff.ts";
import { fillHostGitCredential } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/rpc/git-credential-helper.ts";
import { requiresSandboxedChild } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/cli-launch.ts";
import { parseArgs } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/cli/args.ts";
import { readOnlyMountArguments } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/bwrap-arguments.ts";
const dir=mkdtempSync(join(tmpdir(),'apex-boundary-probe-'));
const workspace=join(dir,'repo'); mkdirSync(workspace); process.chdir(workspace);
try {
const state=join(workspace,'.apex-code','sandbox-state'); mkdirSync(state,{recursive:true});
const victim=join(dir,'outside.txt'); writeFileSync(victim,'ORIGINAL'); symlinkSync(victim,join(state,'terminal-handoff'));
createTerminalHandoff(state).stop(); console.log('HANDOFF_OUTSIDE_CONTENT='+JSON.stringify(readFileSync(victim,'utf8')));
spawnSync('git',['init','-q'],{cwd:workspace});
const marker=join(dir,'host-helper-marker');
const helper=`!f() { printf executed > '${marker}'; printf 'username=dummy\npassword=dummy\n'; }; f`;
spawnSync('git',['config','credential.helper',helper],{cwd:workspace});
const env={PATH:process.env.PATH, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0'};
await fillHostGitCredential({host:'allowed.invalid',protocol:'https'},{environment:env});
console.log('WORKSPACE_HELPER_EXECUTED_ON_HOST='+existsSync(marker));
const capture=join(dir,'git-input'); const helperFile=join(dir,'capture.sh');
writeFileSync(helperFile,`#!/bin/sh
cat > '${capture}'
printf 'username=dummy\npassword=dummy\n'
`,{mode:0o700});
spawnSync('git',['config','credential.helper',helperFile],{cwd:workspace});
await fillHostGitCredential({host:'allowed.invalid',protocol:'https\nhost=other.invalid\n\n'},{environment:env});
console.log('INJECTED_GIT_INPUT='+JSON.stringify(readFileSync(capture,'utf8')));
for(const args of [['--print','--','--help'],['--print','--system-prompt','--version']]) console.log('LAUNCH_CLASSIFICATION='+JSON.stringify({args,sandbox:requiresSandboxedChild(args),parsed:parseArgs(args)}));
console.log('SKILL_MOUNT='+JSON.stringify(readOnlyMountArguments('/home/example/.agents/skills')));
const bwrap=spawnSync('bwrap',['--unshare-user','--unshare-pid','--unshare-net','--ro-bind','/','/','--','/usr/bin/true'],{encoding:'utf8'}); console.log('BWRAP='+JSON.stringify({status:bwrap.status,error:bwrap.error?.message,stderr:bwrap.stderr}));
} finally {process.chdir(dir);rmSync(workspace,{recursive:true,force:true}); rmSync(dir,{recursive:true,force:true});}
