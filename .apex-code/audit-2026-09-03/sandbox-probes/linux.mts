import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import * as net from 'node:net';
import { createLinuxSandboxBackend } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/sandbox/linux-backend.ts";
const dir=mkdtempSync(join(tmpdir(),'apex-live-boundary-')); const workspace=join(dir,'workspace'); mkdirSync(workspace); process.chdir(workspace);
const socketPath=join(dir,'host-only.sock'); let reached=false; const server=net.createServer(socket=>{reached=true;socket.end('synthetic-host-service');});
await new Promise(resolve=>server.listen(socketPath,resolve));
const backend=createLinuxSandboxBackend();
try {
const code=await backend.launch({policy:{workspace,allowedHosts:[],additionalWritableRoots:[]},command:process.execPath,args:['-e',`const fs=require('node:fs'),net=require('node:net'); console.log('ESCALATION_SOCKET_EXISTS='+fs.existsSync(process.env.APEX_COMMAND_ESCALATION_PATH));const s=net.connect(${JSON.stringify(socketPath)});s.on('data',b=>console.log('UNPROJECTED_HOST_UDS='+b));s.on('error',e=>{console.log('UDS_ERROR='+e.code);process.exitCode=1;});`],environment:{PATH:process.env.PATH}});
console.log('LINUX_CHILD_EXIT='+code);console.log('UNPROJECTED_HOST_SERVER_REACHED='+reached);
} finally {await backend.close(); await new Promise(resolve=>server.close(resolve));process.chdir(dir);rmSync(dir,{recursive:true,force:true});}
