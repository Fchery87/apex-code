import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { modelForRole } from "../src/core/model-role.ts";

function model(id: string): Model<any> {
	return { id, provider: "fake", api: "openai-completions" } as Model<any>;
}

describe("model for role", () => {
	it("uses the first model of a resolved role", () => {
		const session = model("session");
		const tiny = model("tiny");
		expect(modelForRole(session, new Map([["tiny", [tiny]]]), "tiny")).toBe(tiny);
	});

	it("keeps the session model when the role is missing or empty", () => {
		const session = model("session");
		expect(modelForRole(session, undefined, "tiny")).toBe(session);
		expect(modelForRole(session, new Map([["tiny", []]]), "tiny")).toBe(session);
		expect(modelForRole(session, new Map(), "plan")).toBe(session);
	});
});
