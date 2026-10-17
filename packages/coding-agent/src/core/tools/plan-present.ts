import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext } from "../extensions/types.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const planPresentDescription = "Present a plan to the user for approval before acting on it.";

const planPresentSchema = Type.Object({
	plan: Type.String({ description: "The plan to present to the user, in markdown." }),
});

export type PlanPresentInput = Static<typeof planPresentSchema>;

export type PlanDecision = { approved: true; nextMode: "acceptEdits" | "default" } | { approved: false };

export interface PlanPresenter {
	present(plan: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<PlanDecision>;
}

export const defaultPlanPresenter: PlanPresenter = {
	async present(plan, ctx, signal) {
		if (!ctx.hasUI)
			throw new Error(
				"plan_present requires interactive UI, which is not available in this session (headless mode).",
			);
		ctx.ui.notify(plan, "info");
		const choice = await ctx.ui.select(
			"Approve this plan?",
			["Yes, and accept edits", "Yes, and ask before each edit", "No, keep planning"],
			{ signal },
		);
		if (choice === "Yes, and accept edits") return { approved: true, nextMode: "acceptEdits" };
		if (choice === "Yes, and ask before each edit") return { approved: true, nextMode: "default" };
		return { approved: false };
	},
};

export interface PlanPresentDetails {
	plan: string;
	approved: boolean;
	nextMode?: "acceptEdits" | "default";
}

export function createPlanPresentToolDefinition(
	presenter: PlanPresenter = defaultPlanPresenter,
): ApexToolDefinition<typeof planPresentSchema, PlanPresentDetails> {
	return {
		name: "plan_present",
		label: "plan_present",
		description: planPresentDescription,
		promptSnippet: planPresentDescription,
		parameters: planPresentSchema,
		contract: {
			capabilities: new Set(["ui"]),
			permission: {
				defaultBehavior: "allow",
				matches: () => false,
				describe: () => "Presenting a plan for approval",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: false, deferSchema: false },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params, result): EvidenceRecord[] => {
					const details = result.details as PlanPresentDetails | undefined;
					return [
						{
							kind: "workflow",
							plan: params.plan,
							approved: details?.approved ?? false,
							...(details?.nextMode ? { nextMode: details.nextMode } : {}),
						},
					];
				},
			},
		},
		async execute(
			_toolCallId,
			{ plan }: PlanPresentInput,
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<PlanPresentDetails>> {
			if (!ctx)
				throw new Error(
					"plan_present requires interactive UI, which is not available in this session (headless mode).",
				);
			signal?.throwIfAborted();
			const decision = await presenter.present(plan, ctx, signal);
			signal?.throwIfAborted();
			const { approved } = decision;
			return {
				content: [{ type: "text", text: approved ? "Plan approved." : "Plan not approved." }],
				details: { plan, ...decision },
			};
		},
	};
}

export function createPlanPresentTool() {
	return wrapToolDefinition(createPlanPresentToolDefinition());
}
