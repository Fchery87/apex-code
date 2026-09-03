import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_WORKSPACE_MAX_ARTIFACTS,
	DEFAULT_WORKSPACE_MAX_PATCH_BYTES,
	DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
	SettingsManager,
} from "../src/core/settings-manager.ts";

/**
 * Pins the workspace-state policy defaults (WS.3, spec
 * 2026-09-01-harness-correctness-and-workspace-state.md). Patch content is
 * opt-in; retention bounds always apply.
 */

const directories: string[] = [];

function scratchPair(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "apex-workspace-settings-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
	return { agentDir, projectDir };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function managerWith(settings: Record<string, unknown>): SettingsManager {
	const { agentDir, projectDir } = scratchPair();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings), "utf-8");
	return SettingsManager.create(projectDir, agentDir);
}

describe("workspace state settings", () => {
	it("defaults to metadata-only capture with bounded retention", () => {
		const { agentDir, projectDir } = scratchPair();
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getWorkspaceState()).toEqual({
			patchCapture: "off",
			maxPatchBytes: DEFAULT_WORKSPACE_MAX_PATCH_BYTES,
			maxArtifacts: DEFAULT_WORKSPACE_MAX_ARTIFACTS,
			maxTotalArtifactBytes: DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
		});
		expect(DEFAULT_WORKSPACE_MAX_PATCH_BYTES).toBe(256 * 1024);
		expect(DEFAULT_WORKSPACE_MAX_ARTIFACTS).toBe(20);
		expect(DEFAULT_WORKSPACE_MAX_TOTAL_BYTES).toBe(2 * 1024 * 1024);
	});

	it("resolves the explicit bounded patch-capture policy", () => {
		const manager = managerWith({
			workspaceState: {
				patchCapture: "bounded",
				maxPatchBytes: 1024,
				maxArtifacts: 3,
				maxTotalArtifactBytes: 4096,
			},
		});

		expect(manager.getWorkspaceState()).toEqual({
			patchCapture: "bounded",
			maxPatchBytes: 1024,
			maxArtifacts: 3,
			maxTotalArtifactBytes: 4096,
		});
	});

	it("merges a partial workspaceState object over the defaults", () => {
		const manager = managerWith({ workspaceState: { patchCapture: "bounded" } });

		expect(manager.getWorkspaceState()).toEqual({
			patchCapture: "bounded",
			maxPatchBytes: DEFAULT_WORKSPACE_MAX_PATCH_BYTES,
			maxArtifacts: DEFAULT_WORKSPACE_MAX_ARTIFACTS,
			maxTotalArtifactBytes: DEFAULT_WORKSPACE_MAX_TOTAL_BYTES,
		});
	});

	it("rejects invalid values at resolution time", () => {
		expect(() => managerWith({ workspaceState: { patchCapture: "always" } }).getWorkspaceState()).toThrow(
			/workspaceState\.patchCapture/,
		);
		expect(() => managerWith({ workspaceState: { maxPatchBytes: 0 } }).getWorkspaceState()).toThrow(
			/workspaceState\.maxPatchBytes/,
		);
		expect(() => managerWith({ workspaceState: { maxArtifacts: -1 } }).getWorkspaceState()).toThrow(
			/workspaceState\.maxArtifacts/,
		);
		expect(() => managerWith({ workspaceState: { maxTotalArtifactBytes: "big" } }).getWorkspaceState()).toThrow(
			/workspaceState\.maxTotalArtifactBytes/,
		);
	});

	it("clamps a patch cap that exceeds the total retention cap", () => {
		const manager = managerWith({ workspaceState: { maxPatchBytes: 999999, maxTotalArtifactBytes: 1024 } });

		expect(manager.getWorkspaceState().maxPatchBytes).toBe(1024);
	});
});
