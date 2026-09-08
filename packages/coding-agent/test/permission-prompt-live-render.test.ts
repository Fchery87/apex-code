import { type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { PermissionPreview } from "../src/core/permissions/responder.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { renderPermissionPreview } from "../src/modes/interactive/components/permission-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * Paint the real prompt onto a real terminal emulator and read the screen back.
 *
 * Every other test here calls `render(width)` and inspects the strings it gets.
 * That never proves the escape sequences composite, that the rows land in the
 * order they were built, or that a long diff stays inside the window. This
 * drives xterm and reads the viewport, which is as close to looking at it as a
 * test gets.
 */
async function paint(preview: PermissionPreview, columns = 80, rows = 24): Promise<string[]> {
	const terminal = new VirtualTerminal(columns, rows);
	const tui: TUI = new TuiMainScreen(terminal);
	const selector = new ExtensionSelectorComponent(
		"Permission required — edit: Edit src/auth.ts",
		["Allow once", "Allow for this session", "Reject and say what to do instead", "Deny"],
		() => {},
		() => {},
		{ preamble: renderPermissionPreview(preview) },
	);
	tui.addChild(selector);
	tui.start();
	tui.requestRender(true);

	// The renderer schedules, and xterm drains its write queue on its own clock.
	// The bound is generous because a loaded machine is the normal case in CI, and
	// a short one here would fail as a blank screen, which reads as a broken
	// feature rather than as a slow one.
	let viewport: string[] = [];
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		viewport = terminal.getViewport().map((line) => line.replace(/\s+$/, ""));
		if (viewport.some((line) => line.length > 0)) break;
	}
	expect(
		viewport.some((line) => line.length > 0),
		"the prompt never painted",
	).toBe(true);
	tui.stop();
	return viewport;
}

describe("the permission prompt on a real terminal", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("paints the change above the choices it justifies", async () => {
		const screen = await paint({
			kind: "diff",
			path: "src/auth.ts",
			lines: ["@@ -1,3 +1,3 @@", "-const s = legacyStore.get(sid)", "+const s = await sessionStore.read(sid)"],
			omittedLines: 0,
		});
		const text = screen.join("\n");

		expect(text).toContain("Permission required");
		expect(text).toContain("src/auth.ts");
		expect(text).toContain("+const s = await sessionStore.read(sid)");
		expect(text).toContain("Allow for this session");
		expect(text.indexOf("sessionStore.read")).toBeLessThan(text.indexOf("Allow once"));
	});

	it("keeps every painted row inside the window", async () => {
		const screen = await paint({
			kind: "diff",
			path: "src/auth.ts",
			lines: Array.from({ length: 8 }, (_, i) => `+ ${"x".repeat(70)} ${i}`),
			omittedLines: 4,
		});

		for (const line of screen) expect(line.length).toBeLessThanOrEqual(80);
		expect(screen.join("\n")).toContain("4 more lines not shown");
	});

	it("says out loud when it cannot show the change", async () => {
		const screen = await paint({ kind: "unavailable", reason: "Authorized read target changed before execution" });
		const text = screen.join("\n");

		// This is the swapped-target case reaching a human. Silence here would read
		// as "nothing changes", which is the one meaning it must never carry.
		expect(text).toContain("Cannot show the change");
		expect(text).toContain("changed before execution");
		expect(text).toContain("Deny");
	});
});
