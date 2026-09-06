import { resolvePermission } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/permissions/rules.ts";
import { createBashPermissionSpec } from "/home/nochaserz/Documents/Coding Projects/apex-code/packages/coding-agent/src/core/tools/bash.ts";
const spec = createBashPermissionSpec();
const allow={source:'session',behavior:'allow',toolName:'bash',ruleContent:'echo ok'};
const deny={...allow,behavior:'deny'};
console.log('same-content allow then deny',resolvePermission([allow,deny],'bash',spec,{command:'echo ok'}).behavior);
console.log('same-content deny then allow',resolvePermission([deny,allow],'bash',spec,{command:'echo ok'}).behavior);
const command = 'Write-Output "x\\"; New-Item hacked; #"';
console.log('powershell input',command);console.log('bash grammar approves PS prefix',spec.matches('Write-Output:*',{command}));
