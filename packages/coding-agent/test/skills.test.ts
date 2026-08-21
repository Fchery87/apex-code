import { homedir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import {
	formatSkillsForPrompt,
	loadSkills,
	loadSkillsFromDir,
	SKILL_CATALOG_PREFIX_BUDGET_TOKENS,
	type Skill,
	slugifySkillCommandName,
} from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow names that don't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(false);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should use parent directory name when name not in frontmatter", () => {
			// The no-frontmatter fixture has no name in frontmatter, so it should use "no-frontmatter"
			// But it also has no description, so it won't load
			// Let's test with a valid skill that relies on directory name
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});
	});

	describe("formatSkillsForPrompt (SKILL.6, name-only catalog per ADR 0021)", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skill names as XML, without description or location", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).not.toContain("<description>");
			expect(result).not.toContain("<location>");
			expect(result).not.toContain("A test skill.");
			expect(result).not.toContain("/path/to/skill/SKILL.md");
		});

		it("should include intro text pointing at skill_search before the XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("skill_search");
			expect(introText).toContain("use the read tool to load its file");
		});

		it("should escape XML special characters in a skill name", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: '<special> & "name"',
					description: "irrelevant",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;name&quot;");
		});

		it("should list multiple skill names alphabetically regardless of input order", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const oneIndex = result.indexOf("<name>skill-one</name>");
			const twoIndex = result.indexOf("<name>skill-two</name>");

			expect(oneIndex).toBeGreaterThan(-1);
			expect(twoIndex).toBeGreaterThan(oneIndex);
		});

		it("should exclude skills with disableModelInvocation from the catalog", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});

		it("stops adding names once the budget is spent and reports how many were omitted", () => {
			// Each name easily exceeds a tiny budget on its own, so with three skills
			// and a budget too small even for the header, everything is omitted.
			const skills: Skill[] = ["skill-alpha", "skill-beta", "skill-gamma"].map((name) =>
				createTestSkill({
					name,
					description: "irrelevant",
					filePath: `/p/${name}/SKILL.md`,
					baseDir: `/p/${name}`,
				}),
			);

			const result = formatSkillsForPrompt(skills, 1);

			expect(result).not.toContain("<name>");
			expect(result).toContain("3 more skills omitted for space; call skill_search to find them");
		});

		it("includes a clean alphabetical prefix, counts the rest as omitted, and never exceeds the budget once truncated", () => {
			// Long names so a handful of them clearly costs more than the fixed
			// omitted-count comment line -- with short names the comment line's own
			// prose can outweigh a few extra <name> tags, which would let the "fit
			// everything" branch win before truncation is ever exercised.
			const names = Array.from(
				{ length: 20 },
				(_, i) => `very-long-skill-name-number-${String(i).padStart(2, "0")}`,
			);
			const skills: Skill[] = names.map((name) =>
				createTestSkill({
					name,
					description: "irrelevant",
					filePath: `/p/${name}/SKILL.md`,
					baseDir: `/p/${name}`,
				}),
			);
			const fullBudget = Math.ceil(formatSkillsForPrompt(skills, 1_000_000).length / 4);
			// Comfortably above the fixed header+comment overhead (leaving room for
			// several names), but well under the full list's cost.
			const partialBudget = Math.round(fullBudget * 0.6);

			const result = formatSkillsForPrompt(skills, partialBudget);

			const includedNames = [...result.matchAll(/<name>(.+?)<\/name>/g)].map((match) => match[1]);
			expect(includedNames.length).toBeGreaterThan(0);
			expect(includedNames.length).toBeLessThan(names.length);
			const sortedNames = [...names].sort((a, b) => a.localeCompare(b));
			expect(includedNames).toEqual(sortedNames.slice(0, includedNames.length));
			const omittedCount = names.length - includedNames.length;
			expect(result).toContain(
				`${omittedCount} more skill${omittedCount === 1 ? "" : "s"} omitted for space; call skill_search to find them`,
			);
			// The regression this guards: the omitted-count comment line's own cost
			// must be reserved, or the truncated output (names + that comment line)
			// can itself exceed the budget it was supposed to respect.
			expect(Math.ceil(result.length / 4)).toBeLessThanOrEqual(partialBudget);
		});

		it("stays bounded for a 500-skill library regardless of the default production budget", () => {
			const skills: Skill[] = Array.from({ length: 500 }, (_, i) =>
				createTestSkill({
					name: `skill-${String(i).padStart(4, "0")}`,
					description: "irrelevant",
					filePath: `/p/${i}/SKILL.md`,
					baseDir: `/p/${i}`,
				}),
			);

			const result = formatSkillsForPrompt(skills);

			expect(Math.ceil(result.length / 4)).toBeLessThanOrEqual(SKILL_CATALOG_PREFIX_BUDGET_TOKENS);
			expect(result).toContain("more skills omitted for space; call skill_search to find them");
		});

		it("never includes a description or location, even under a generous budget", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A description that must not leak into the prefix.",
					filePath: "/must/not/leak/SKILL.md",
					baseDir: "/must/not/leak",
				}),
			];

			const result = formatSkillsForPrompt(skills, 100_000);

			expect(result).not.toContain("A description that must not leak into the prefix.");
			expect(result).not.toContain("/must/not/leak/SKILL.md");
		});
	});

	describe("slugifySkillCommandName (SKILL.5)", () => {
		it("leaves an already-valid command-safe name unchanged", () => {
			expect(slugifySkillCommandName("agent-browser")).toBe("agent-browser");
		});

		it("lowercases and hyphenates a name with spaces and capitals", () => {
			expect(slugifySkillCommandName("Poteto Mode")).toBe("poteto-mode");
		});

		it("collapses a run of invalid characters into a single hyphen", () => {
			expect(slugifySkillCommandName("Foo!!  Bar??")).toBe("foo-bar");
		});

		it("trims leading and trailing hyphens produced by leading/trailing invalid characters", () => {
			expect(slugifySkillCommandName("__Foo Bar__")).toBe("foo-bar");
		});

		it("falls back to a stable non-empty token for a name with no valid characters at all", () => {
			expect(slugifySkillCommandName("!!!")).toBe("skill");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".apex-code/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.apex-code/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			// Load from first directory
			const first = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "first"),
				source: "first",
			});

			const second = loadSkillsFromDir({
				dir: join(collisionFixturesDir, "second"),
				source: "second",
			});

			// Simulate the collision behavior from loadSkills()
			const skillMap = new Map<string, Skill>();
			const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

			for (const skill of first.skills) {
				skillMap.set(skill.name, skill);
			}

			for (const skill of second.skills) {
				const existing = skillMap.get(skill.name);
				if (existing) {
					collisionWarnings.push({
						skillPath: skill.filePath,
						message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
					});
				} else {
					skillMap.set(skill.name, skill);
				}
			}

			expect(skillMap.size).toBe(1);
			expect(skillMap.get("calendar")?.sourceInfo.source).toBe("first");
			expect(collisionWarnings).toHaveLength(1);
			expect(collisionWarnings[0].message).toContain("name collision");
		});
	});
});
