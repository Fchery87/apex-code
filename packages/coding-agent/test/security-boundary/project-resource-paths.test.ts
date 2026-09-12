import { globSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { PROJECT_RESOURCES, projectResourcePath, projectResourcePathByName } from "../../src/core/project-resources.ts";

const SRC = join(import.meta.dirname, "..", "..", "src");

/**
 * The classifier and the loaders have to resolve project resources to the same paths or
 * the trust boundary has a hole that no behavioral test sees. Relocating the name list
 * into a registry does not achieve that on its own: a loader composing
 * `join(cwd, ".apex-code", …)` by hand diverges the moment `piConfig.configDir`
 * overrides `CONFIG_DIR_NAME`, which reintroduces the original bypass silently.
 */
describe("project resource paths resolve in one place", () => {
	it("refuses a resource that is not in the registry, so a loader cannot read an ungated path", () => {
		expect(() => projectResourcePathByName("/tmp/x", "unregistered.json")).toThrow(/Unknown project resource/);
	});

	it("resolves every registry entry through the configured config directory", () => {
		for (const resource of PROJECT_RESOURCES) {
			const resolved = projectResourcePath("/tmp/x", resource);
			const expected =
				resource.scope === "config-dir"
					? join("/tmp/x", CONFIG_DIR_NAME, resource.name)
					: join("/tmp/x", resource.name);
			expect(resolved).toBe(expected);
		}
	});

	it("has no first-party source that can diverge from the classifier on a gated path", () => {
		// The invariant is narrower than "never build a path by hand". A project-scoped path
		// built with CONFIG_DIR_NAME cannot diverge from the classifier, which resolves the
		// same constant, so `join(this.cwd, CONFIG_DIR_NAME, "skills")` is safe and several
		// loaders still do it.
		//
		// Two shapes can diverge and are rejected here. A hardcoded config-directory literal
		// beside a gated name drifts the moment `piConfig.configDir` is overridden, which is
		// the bug this slice fixed. A root-scoped gated resource such as `.mcp.json` carries
		// no config-directory literal at all, so it needs its own check.
		//
		// User-scope paths are out of scope: `~/.apex-code/settings.json` and
		// `~/.apex-code/themes` share filenames with gated resources but are the user's own
		// trusted resources, which project trust does not gate.
		const quoteStyles = (name: string) => [`"${name}"`, `'${name}'`, `\`${name}\``];
		const gated = PROJECT_RESOURCES.map((resource) => resource.name);
		const rootGated = PROJECT_RESOURCES.filter((resource) => resource.scope === "root").map((r) => r.name);
		const projectRooted = /join\(\s*[^,)]*\b(cwd|workspace|projectRoot|projectDir|projectPath)\b/i;
		const offenders: string[] = [];
		const files = globSync("**/*.ts", { cwd: SRC })
			.filter((file) => !file.includes("vendor/"))
			.map((file) => join(SRC, file));

		for (const file of files) {
			if (file.endsWith(join("core", "project-resources.ts"))) continue;
			const text = readFileSync(file, "utf8");
			for (const [index, line] of text.split("\n").entries()) {
				const hardcodedConfigDir = /["'`]\.apex-code["'`]/.test(line);
				const namesGatedHere = hardcodedConfigDir ? gated : rootGated;
				if (!hardcodedConfigDir && !projectRooted.test(line)) continue;
				const hit = namesGatedHere.some((name) => quoteStyles(name).some((lit) => line.includes(lit)));
				if (hit) offenders.push(`${relative(SRC, file)}:${index + 1}`);
			}
		}

		expect(
			offenders,
			`resolve these through projectResourcePath so the classifier and the loader cannot diverge:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
