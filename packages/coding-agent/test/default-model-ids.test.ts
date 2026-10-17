import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { defaultModelPerProvider } from "../src/core/model-resolver.ts";

describe("default model ids exist in the bundled catalog (HR.18)", () => {
	for (const [provider, id] of Object.entries(defaultModelPerProvider)) {
		it(`${provider} default ${id} is a catalog model`, () => {
			expect(getModel(provider as never, id as never)).toBeDefined();
		});
	}

	it("Anthropic and Bedrock default to the current Opus line", () => {
		expect(defaultModelPerProvider.anthropic).toBe("claude-opus-5-5");
		expect(defaultModelPerProvider["amazon-bedrock"]).toBe("us.anthropic.claude-opus-5-5");
	});

	it("the catalog carries the current Sonnet and Haiku 5.5 models", () => {
		expect(getModel("anthropic" as never, "claude-sonnet-5-5" as never)).toBeDefined();
		expect(getModel("anthropic" as never, "claude-haiku-5-5" as never)).toBeDefined();
	});
});
