import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Container } from "../../tui/src/tui.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * A `this` carrying only what the two methods under test read. The house pattern from
 * `interactive-mode-status.test.ts`: constructing a whole TUI to reach a method would
 * test the TUI instead.
 */
/** A partial `this` reaching private prototype methods, so it is deliberately untyped. */
type FakeMode = any;

function fakeMode(options: {
	prompts?: Array<{ name: string; description: string }>;
	extensionCommands?: Array<{ name: string; invocationName: string; description: string }>;
	skills?: Array<{ name: string; description: string }>;
}): FakeMode {
	// `session` and `settingsManager` are getters on the prototype, so they are defined as
	// own properties rather than assigned.
	return Object.defineProperties(Object.create(InteractiveMode.prototype), {
		skillCommands: { value: new Map<string, string>(), writable: true },
		settingsManager: { value: { getEnableSkillCommands: () => true } },
		session: {
			value: {
				promptTemplates: options.prompts ?? [],
				extensionRunner: { getRegisteredCommands: () => options.extensionCommands ?? [] },
				resourceLoader: {
					getSkills: () => ({
						skills: (options.skills ?? []).map((skill) => ({ ...skill, filePath: `/skills/${skill.name}.md` })),
					}),
				},
			},
		},
		chatContainer: { value: new Container(), writable: true },
		outputPad: { value: 0 },
		ui: { value: { requestRender: () => {} } },
		// The real theme, because `Markdown` renders a table through it and a stub one would
		// make this assert the stub rather than the output a user sees.
		getMarkdownThemeWithSettings: { value: () => getMarkdownTheme() },
	});
}

function render(container: Container, width = 200): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("/help", () => {
	beforeAll(() => initTheme("dark"));

	it("is a registered builtin command", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain("help");
	});

	it("collects builtin, prompt, extension, and skill commands together", () => {
		const mode = fakeMode({
			prompts: [{ name: "review", description: "a prompt template" }],
			extensionCommands: [{ name: "deploy", invocationName: "deploy", description: "an extension command" }],
			skills: [{ name: "Debugging", description: "a skill" }],
		});

		const names = mode.collectSessionCommands().map((command: { name: string }) => command.name);

		expect(names).toContain("help");
		expect(names).toContain("review");
		expect(names).toContain("deploy");
		expect(names).toContain("skill:debugging");
	});

	it("renders every command the collection returns", () => {
		const mode = fakeMode({
			prompts: [{ name: "review", description: "a prompt template" }],
			extensionCommands: [{ name: "deploy", invocationName: "deploy", description: "an extension command" }],
			skills: [{ name: "Debugging", description: "a skill" }],
		});
		const collected = mode.collectSessionCommands().map((command: { name: string }) => command.name);

		mode.handleHelpCommand();
		const output = render(mode.chatContainer);

		// Compared against the collection rather than a fixed list, so a command added to
		// one source cannot be rendered by neither surface without failing here.
		expect(collected.filter((name: string) => !output.includes(`/${name}`))).toEqual([]);
	});
});

describe("commands the README teaches", () => {
	/**
	 * The regression that motivated this file. `README.md` has taught `/help` as the first
	 * command to run since before one existed. Asserting the whole documented block rather
	 * than that one name is what stops the next documented command from going missing.
	 */
	it("all exist in the builtin table", () => {
		const readme = readFileSync(join(import.meta.dirname, "..", "..", "..", "README.md"), "utf8");
		const block = readme.split("Useful first-session commands include:")[1]?.split("```")[1] ?? "";
		const documented = [...block.matchAll(/^\/(\S+)/gm)].map((match) => match[1]);
		const registered = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

		expect(documented.length).toBeGreaterThan(0);
		expect(documented.filter((name) => !registered.has(name))).toEqual([]);
	});
});
