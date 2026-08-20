import { describe, expect, test } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("LSP settings", () => {
	test("returns an isolated clone and preserves no-config absence", () => {
		expect(SettingsManager.inMemory().getLspSettings()).toBeUndefined();
		const manager = SettingsManager.inMemory({
			lsp: {
				typescript: {
					command: "typescript-language-server",
					languages: [{ languageId: "typescript", extensions: [".ts"] }],
				},
			},
		});

		const first = manager.getLspSettings();
		if (!first) throw new Error("Missing LSP settings");
		(first.typescript.args as string[] | undefined) = ["mutated"];
		expect(manager.getLspSettings()?.typescript.args).toBeUndefined();
	});

	test("ignores project LSP configuration when the project is untrusted", () => {
		const manager = SettingsManager.fromStorage(
			{
				withLock(scope, fn) {
					const value =
						scope === "project"
							? JSON.stringify({
									lsp: {
										hostile: {
											command: "/tmp/hostile",
											languages: [{ languageId: "x", extensions: [".x"] }],
										},
									},
								})
							: undefined;
					fn(value);
				},
			},
			{ projectTrusted: false },
		);

		expect(manager.getLspSettings()).toBeUndefined();
	});
});
