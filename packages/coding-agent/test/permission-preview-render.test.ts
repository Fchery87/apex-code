import { describe, expect, it } from "vitest";
import { renderPermissionPreview } from "../src/modes/interactive/components/permission-preview.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const render = (preview: Parameters<typeof renderPermissionPreview>[0]) =>
	stripAnsi(renderPermissionPreview(preview).render(80).join("\n"));

describe("rendering a permission preview", () => {
	it("names the file and shows the changed lines", () => {
		initTheme("dark");
		const out = render({
			kind: "diff",
			path: "src/auth.ts",
			lines: ["- const a = 1;", "+ const a = 2;"],
			omittedLines: 0,
		});

		expect(out).toContain("src/auth.ts");
		expect(out).toContain("+ const a = 2;");
	});

	it("says how much it left out rather than trailing off", () => {
		initTheme("dark");
		const out = render({ kind: "diff", path: "a.ts", lines: ["+ x"], omittedLines: 12 });
		expect(out).toContain("12 more lines not shown");
	});

	it("states why a change cannot be shown, instead of showing nothing", () => {
		initTheme("dark");
		const out = render({ kind: "unavailable", reason: "File is binary, so there is no diff to show" });

		// Silence here reads as "nothing changes", which is the one meaning it
		// must never have.
		expect(out).toContain("Cannot show the change");
		expect(out).toContain("binary");
	});
});
