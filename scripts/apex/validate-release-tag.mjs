#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SEMVER_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const repoRoot = resolve(process.argv[3] ?? ".");

function readManifest(directory) {
	return JSON.parse(readFileSync(join(repoRoot, directory, "package.json"), "utf8"));
}

try {
	if (!tag || !SEMVER_TAG_RE.test(tag)) {
		throw new Error(`Release tag must be v<semver>; received ${JSON.stringify(tag)}`);
	}

	const version = tag.slice(1);
	const agentCore = readManifest("packages/agent");
	const codingAgent = readManifest("packages/coding-agent");

	if (agentCore.name !== "apex-code-agent-core" || codingAgent.name !== "apex-code") {
		throw new Error("Release manifests must contain the two Apex-owned package names");
	}
	if (agentCore.version !== codingAgent.version) {
		throw new Error(`Apex-owned package versions must match: ${agentCore.version} != ${codingAgent.version}`);
	}
	if (version !== codingAgent.version) {
		throw new Error(`Release tag ${tag} does not match package version ${codingAgent.version}`);
	}
	if (codingAgent.dependencies?.[agentCore.name] !== version) {
		throw new Error(`${codingAgent.name} must depend exactly on ${agentCore.name}@${version}`);
	}

	console.log(version);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
