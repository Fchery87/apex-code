import { describe, expect, it } from "vitest";
import {
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatNoModelsAvailableMessage,
	getProviderLoginHelp,
} from "../src/core/auth-guidance.ts";

describe("provider login guidance", () => {
	it("names the next command before it names a documentation path", () => {
		const help = getProviderLoginHelp();
		expect(help).toContain("providers.md");
		expect(help).toContain("models.md");
		expect(help).not.toContain("/login");
		expect(help).not.toMatch(/^\s*\//m);
	});

	it("keeps the recovery instruction on the first line of every no-provider message", () => {
		for (const message of [
			formatNoModelsAvailableMessage(),
			formatNoModelSelectedMessage(),
			formatNoApiKeyFoundMessage("anthropic"),
		]) {
			expect(message.split("\n")[0]).toContain("/login");
			expect(message.split("\n")[0]).not.toContain("providers.md");
		}
	});
});
