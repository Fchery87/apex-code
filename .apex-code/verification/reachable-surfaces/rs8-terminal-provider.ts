import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.ts";
export default function (pi: ExtensionAPI) {
 pi.registerProvider("task-probe", {
  api: "task-probe-api", apiKey: "$APEX_TERMINAL_PROBE_TOKEN", baseUrl: "http://localhost/unused",
  models: [{id:"probe",name:"Task panel probe",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:8192}],
  streamSimple: (model, context) => {
   const stream=createAssistantMessageEventStream();
   const last=context.messages.at(-1);
   const writes=last?.role === "user";
   const prompt=last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.filter(part=>part.type === "text").map(part=>part.text).join(" ")) : "";
   const complete=prompt.toLowerCase().includes("complete");
   const todos=prompt.toLowerCase().includes("clear") ? [] : ["Inspect files","Implement task panel","Verify lifecycle","Review settings","Run focused tests","Check terminal"].map((content,index)=>({content,status:complete ? "completed" : index===0 ? "completed" : index===1 ? "in_progress" : "pending"}));
   const content=writes ? [fauxToolCall("todo_write",{todos})] : "Task update returned.";
   const message={...fauxAssistantMessage(content),api:model.api,provider:model.provider,model:model.id,stopReason:writes ? "toolUse" as const : "stop" as const};
   stream.push({type:"start",partial:message});stream.push({type:"done",reason:message.stopReason,message});stream.end(message);return stream;
  }
 });
}
