import type { TextContent } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult } from "apex-code-agent-core";
import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";
import { appendMemoryNote } from "../memory-notes.ts";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const schema = Type.Object({
	title: Type.String({ description: "Short title. The note is not loaded until the user accepts it." }),
	body: Type.String({ description: "The note. A secret is refused and not written." }),
});

export type MemoryNoteInput = Static<typeof schema>;

export interface MemoryNoteDetails {
	written: boolean;
	path?: string;
}

function textBlock(text: string): TextContent {
	return { type: "text", text };
}

export function createMemoryNoteToolDefinition(cwd: string): ApexToolDefinition<typeof schema, MemoryNoteDetails> {
	return {
		name: "memory_note",
		label: "memory note",
		description:
			"Append a note to the project inbox. The next session does not load it until the user accepts it. Refuses a note that contains a secret.",
		parameters: schema,
		contract: {
			capabilities: new Set(["fs.write"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent) => minimatch("memory_note", ruleContent, { dot: true }),
				describe: () => "Append a note to the project memory inbox",
				ruleForCall: () => "memory_note",
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(_toolCallId, input): Promise<AgentToolResult<MemoryNoteDetails>> {
			const written = appendMemoryNote(cwd, input);
			if (written.refused) {
				return { content: [textBlock(written.refused)], details: { written: false } };
			}
			return {
				content: [textBlock(`Wrote ${written.path} to the inbox. It does not load until you accept it.`)],
				details: { written: true, path: written.path },
			};
		},
	};
}

export function createMemoryNoteTool(cwd: string) {
	return wrapToolDefinition(createMemoryNoteToolDefinition(cwd));
}
