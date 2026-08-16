import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const askUserSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user." }),
	options: Type.Array(Type.String(), { description: "The choices to present to the user." }),
});

export type AskUserInput = Static<typeof askUserSchema>;

export interface AskUserDetails {
	question: string;
	answer: string | undefined;
}

function formatAnswer(answer: string | undefined): string {
	return answer !== undefined ? `User selected: ${answer}` : "User did not answer (question was dismissed).";
}

/**
 * The `ui` capability's first implementor: a structured question presented through
 * the same `ctx.ui` extensions already use (`ExtensionUIContext.select`). Headless
 * sessions (`--print`, JSON, RPC without a bound UI) install a no-op `ui` whose
 * `select` silently resolves `undefined` -- indistinguishable from a user dismissing
 * the question unless this checks `ctx.hasUI` first and fails closed instead.
 */
export function createAskUserToolDefinition(): ApexToolDefinition<typeof askUserSchema, AskUserDetails> {
	return {
		name: "ask_user",
		label: "ask_user",
		description: "Ask the user a structured question with a fixed set of options and wait for their answer.",
		parameters: askUserSchema,
		contract: {
			capabilities: new Set(["ui"]),
			permission: {
				defaultBehavior: "allow",
				matches: () => false,
				describe: () => "Asking the user a question",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(
			_toolCallId,
			{ question, options }: AskUserInput,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<AskUserDetails>> {
			if (!ctx?.hasUI) {
				throw new Error(
					"ask_user requires interactive UI, which is not available in this session (headless mode).",
				);
			}
			const answer = await ctx.ui.select(question, options);
			return {
				content: [{ type: "text", text: formatAnswer(answer) }],
				details: { question, answer },
			};
		},
	};
}

export function createAskUserTool() {
	return wrapToolDefinition(createAskUserToolDefinition());
}
