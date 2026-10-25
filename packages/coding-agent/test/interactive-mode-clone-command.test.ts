import { describe, expect, it } from "vitest";
import { slashCommandTarget } from "../src/modes/interactive/interactive-mode.ts";

describe("slash command routing", () => {
	it("sends /config to settings and /clone to the same place as /fork", () => {
		expect(slashCommandTarget("/config")).toBe("settings");
		expect(slashCommandTarget("/settings")).toBeUndefined();
		expect(slashCommandTarget("/clone")).toBe(slashCommandTarget("/fork"));
		expect(slashCommandTarget("/diff")).toBe("diff");
		expect(slashCommandTarget("/help")).toBeUndefined();
	});
});
