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

	it("has no first-party source composing a gated resource path by hand", () => {
		// Scoped to the gated resources. The sandbox backends also hardcode the config
		// directory for their own runtime state (`sandbox-state`, `sandbox-handoff-ack`),
		// which is written by the supervisor rather than read as project config, so it is
		// not part of this boundary. That hardcoding is its own latent inconsistency with
		// a `piConfig.configDir` override and belongs in its own change.
		const gatedNames = PROJECT_RESOURCES.map((resource) => resource.name);
		const offenders: string[] = [];
		const files = globSync("**/*.ts", { cwd: SRC })
			.filter((file) => !file.includes("vendor/"))
			.map((file) => join(SRC, file));

		for (const file of files) {
			if (file.endsWith(join("core", "project-resources.ts"))) continue;
			const text = readFileSync(file, "utf8");
			for (const [index, line] of text.split("\n").entries()) {
				if (!/["'`]\.apex-code["'`]/.test(line)) continue;
				if (!gatedNames.some((name) => line.includes(`"${name}"`))) continue;
				offenders.push(`${relative(SRC, file)}:${index + 1}`);
			}
		}

		expect(
			offenders,
			`compose these through projectResourcePath/projectConfigDir so the classifier and the loader cannot diverge:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
