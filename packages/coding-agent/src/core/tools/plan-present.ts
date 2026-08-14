import { Type, type Static } from "typebox";
import type { AgentToolResult } from "apex-code-agent-core";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const planPresentSchema = Type.Object({
	plan: Type.String({ description: "The plan to present to the user, in markdown." }),
});

export type PlanPresentInput = Static<typeof planPresentSchema>;

export interface PlanPresentDetails {
	plan: string;
	approved: boolean;
}

/**
 * The tool by which an agent presents its plan for approval, closing the gap the
 * spec names: plan mode can deny mutation but had no tool to leave it through.
 * `deferSchema: false` matches the default four tools' exclusion reasoning -- this
 * is called on nearly every plan-mode turn, so deferring would trade a one-time
 * prefix saving for a recurring round trip.
 *
 * Deliberately does not itself change the permission mode: no such seam exists for
 * tools or extensions today (only the CLI/TUI can), so this tool's job ends at
 * reporting the user's approve/reject decision for the harness to act on.
 */
export function createPlanPresentToolDefinition(): ApexToolDefinition<typeof planPresentSchema, PlanPresentDetails> {
	return {
		name: "plan_present",
		label: "plan_present",
		description: "Present a plan to the user for approval before acting on it.",
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
					return [{ kind: "workflow", plan: params.plan, approved: details?.approved ?? false }];
				},
			},
		},
		async execute(
			_toolCallId,
			{ plan }: PlanPresentInput,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<PlanPresentDetails>> {
			if (!ctx?.hasUI) {
				throw new Error(
					"plan_present requires interactive UI, which is not available in this session (headless mode).",
				);
			}
			const approved = await ctx.ui.confirm("Approve this plan?", plan);
			return {
				content: [{ type: "text", text: approved ? "Plan approved." : "Plan not approved." }],
				details: { plan, approved },
			};
		},
	};
}

export function createPlanPresentTool() {
	return wrapToolDefinition(createPlanPresentToolDefinition());
}
