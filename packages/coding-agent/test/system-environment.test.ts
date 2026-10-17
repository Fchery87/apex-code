import { describe, expect, it } from "vitest";
import { buildEnvironmentSection } from "../src/core/system-environment.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";

const base = {
	date: "2026-10-16",
	platform: "linux",
	shell: "/bin/bash",
	model: "claude-opus-5-5",
};

describe("environment section (HR.16)", () => {
	it("states the date, platform, shell, model, and git state", () => {
		const text = buildEnvironmentSection({ ...base, git: { branch: "main", dirty: true } });
		expect(text).toContain("2026-10-16");
		expect(text).toContain("linux");
		expect(text).toContain("/bin/bash");
		expect(text).toContain("claude-opus-5-5");
		expect(text).toContain("main");
		expect(text).toMatch(/uncommitted changes/);
	});

	it("says plainly when the working directory is not a git repository", () => {
		expect(buildEnvironmentSection({ ...base, git: undefined })).toMatch(/not a git repository/);
	});

	it("is the last system prompt section, so the earlier bytes stay cacheable", () => {
		const sections = buildSystemPromptSections({
			cwd: "/work",
			sections: { environment: buildEnvironmentSection({ ...base, git: undefined }) },
		});
		expect(Object.keys(sections).at(-1)).toBe("environment");
	});

	it("changing only the date leaves every earlier section byte-identical", () => {
		const build = (date: string) =>
			buildSystemPromptSections({
				cwd: "/work",
				sections: { environment: buildEnvironmentSection({ ...base, date, git: undefined }) },
			});
		const today = build("2026-10-16");
		const tomorrow = build("2026-10-17");
		const { environment: a, ...prefixA } = today;
		const { environment: b, ...prefixB } = tomorrow;
		expect(prefixB).toEqual(prefixA);
		expect(a).not.toEqual(b);
	});
});
