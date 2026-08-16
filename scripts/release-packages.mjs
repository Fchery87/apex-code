import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const APEX_PUBLIC_PACKAGES = ["packages/agent", "packages/coding-agent"];

export function getPublicWorkspacePackages(root = process.cwd()) {
	return APEX_PUBLIC_PACKAGES.map((relativeDirectory) => {
		const directory = resolve(root, relativeDirectory);
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		return { directory, name: manifest.name, version: manifest.version };
	});
}
