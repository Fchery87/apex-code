import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FilePermissionRuleStore, type PermissionMode } from "../src/core/permissions/store.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("plan mode model role", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness() {
		const provider = `plan-role-${Math.random().toString(36).slice(2)}`;
		const created = await createHarness({
			provider,
			models: [
				{ id: "session-model", name: "Session" },
				{ id: "plan-model", name: "Plan" },
			],
			modelsJson: {
				providers: {},
				roles: { plan: { models: [`${provider}/plan-model`] } },
			},
			permissionGate: {
				store: new FilePermissionRuleStore({
					cwd: "/tmp",
					agentDir: "/tmp/absent-agent",
					policyPath: "/tmp/absent-policy.json",
					projectTrusted: true,
				}),
				getMode: async (): Promise<PermissionMode> => "default",
			},
		});
		harnesses.push(created);
		return created;
	}

	it("sends the plan model without recording a session model change", async () => {
		const { session, setResponses, getModel } = await harness();
		const seen: string[] = [];
		const original = session.agent.streamFunction;
		session.agent.streamFunction = (model, context, options) => {
			seen.push(model.id);
			return original(model, context, options);
		};
		setResponses([fauxAssistantMessage("planned")]);

		await session.setInteractivePermissionMode("plan");
		await session.prompt("plan the change");

		expect(seen).toEqual(["plan-model"]);
		expect(session.model?.id).toBe(getModel().id);
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "model_change")).toBe(false);
	});

	it("keeps the session model when plan mode is off", async () => {
		const { session, setResponses, getModel } = await harness();
		const seen: string[] = [];
		const original = session.agent.streamFunction;
		session.agent.streamFunction = (model, context, options) => {
			seen.push(model.id);
			return original(model, context, options);
		};
		setResponses([fauxAssistantMessage("done")]);

		await session.prompt("do the change");

		expect(seen).toEqual([getModel().id]);
	});
});
