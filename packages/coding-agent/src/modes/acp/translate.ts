/**
 * ACP translation (spec 2026-08-31-acp-adapter.md): maps Apex session/json
 * events onto ACP v1 `session/update` variants. Deliberately stateless --
 * first-sight versus update for tool calls is the server's concern. Unknown
 * events translate to nothing rather than guessing at a shape.
 */

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

export interface AcpToolCallUpdate {
	toolCallId: string;
	title?: string;
	kind?: AcpToolKind;
	status?: "pending" | "in_progress" | "completed" | "failed";
}

export type AcpUpdate =
	| { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
	| ({ sessionUpdate: "tool_call" } & AcpToolCallUpdate)
	| ({ sessionUpdate: "tool_call_update" } & AcpToolCallUpdate);

export type TranslatedEvent =
	| {
			kind: "message";
			update: Extract<AcpUpdate, { sessionUpdate: "agent_message_chunk" }>;
	  }
	| { kind: "tool"; toolCallId: string; update: AcpToolCallUpdate };

const TOOL_KINDS: Record<string, AcpToolKind> = {
	read: "read",
	edit: "edit",
	write: "edit",
	bash: "execute",
	powershell: "execute",
	grep: "search",
	find: "search",
	ls: "search",
	web_fetch: "fetch",
	web_search: "search",
};

export function toolKind(toolName: string): AcpToolKind {
	return TOOL_KINDS[toolName] ?? "other";
}

export function translateJsonEvent(event: unknown): TranslatedEvent | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const record = event as Record<string, unknown>;
	if (record.type !== "message_update") return undefined;
	const partial = record.partial as Record<string, unknown> | undefined;
	if (typeof partial !== "object" || partial === null) return undefined;

	if (partial.type === "text_delta" && typeof partial.delta === "string") {
		return {
			kind: "message",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: partial.delta } },
		};
	}
	if (partial.type === "toolcall_start" && typeof partial.id === "string") {
		const toolName = typeof partial.toolName === "string" ? partial.toolName : "tool";
		return {
			kind: "tool",
			toolCallId: partial.id,
			update: { toolCallId: partial.id, title: toolName, kind: toolKind(toolName), status: "pending" },
		};
	}
	if ((partial.type === "toolcall_finish" || partial.type === "toolcall_end") && typeof partial.id === "string") {
		return { kind: "tool", toolCallId: partial.id, update: { toolCallId: partial.id, status: "completed" } };
	}
	return undefined;
}
