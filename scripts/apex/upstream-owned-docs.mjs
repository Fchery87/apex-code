import { FROZEN_PACKAGE_DIRECTORIES } from "./frozen-packages.mjs";

/**
 * Prose that arrives with each upstream merge and describes upstream's tree, not Apex
 * Code's: upstream's plans and design notes, the READMEs of the source-only experimental
 * layer, and every consumed package's docs, which ADR 0001 forbids editing. Checks that
 * hold current documents to Apex's code skip these by prefix.
 */
export const UPSTREAM_OWNED_DOCS = [
	"packages/agent/docs/work-packages/",
	"packages/agent/docs/mobile-handoff/",
	"packages/coding-agent/src/experimental/",
	...FROZEN_PACKAGE_DIRECTORIES.map((dir) => `${dir}/`),
];
