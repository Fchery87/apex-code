import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { ComposerDock } from "../src/modes/interactive/components/composer-dock.ts";

describe("ComposerDock", () => {
	test("insets anything but the composer to the composer prompt's column", () => {
		const composer = new Text("› draft", 0, 0);
		const dock = new ComposerDock(() => composer);

		dock.addChild(new Text("Select a provider", 0, 0));
		expect(dock.render(40).map((line) => line.trimEnd())).toEqual(["  Select a provider"]);

		dock.clear();
		dock.addChild(composer);
		expect(dock.render(40).map((line) => line.trimEnd())).toEqual(["› draft"]);
	});

	test("never renders wider than the width it was given", () => {
		const dock = new ComposerDock(() => undefined);
		dock.addChild(new Text("x".repeat(60), 0, 0));

		for (const line of dock.render(20)) expect(line.length).toBeLessThanOrEqual(20);
	});
});
