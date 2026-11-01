import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function generatedAgentInventory() {
	const definitions = JSON.parse(
		execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				'import { BUILT_IN_AGENT_DEFINITIONS } from "./packages/coding-agent/src/core/delegation/agents.ts"; console.log(JSON.stringify(BUILT_IN_AGENT_DEFINITIONS));',
			],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.runtime.json" },
			},
		),
	);
	return [
		"<!-- builtin-agent-inventory:start -->",
		...definitions.map(({ name, description }) => `- \`${name}\`: ${description}`),
		"<!-- builtin-agent-inventory:end -->",
	].join("\n");
}

export function checkProductClaims(readme, context, packageReadme = readme) {
	const errors = [];
	const inventory = generatedAgentInventory();
	for (const [path, contents] of [["README.md", readme], ["packages/coding-agent/README.md", packageReadme]]) {
		if (!contents.includes(inventory)) errors.push(`${path}: built-in agent inventory differs from shipped definitions`);
		if (!contents.includes("versioned JSON definition") || !contents.includes("not crash-resumable")) {
			errors.push(`${path}: JSON workflow migration and recovery boundary must be documented`);
		}
	}
	if (/SpecEngine \+ governance/.test(context)) {
		errors.push("CONTEXT.md: bundled SpecEngine claim has no production entry point");
	}
	return errors;
}
