/**
 * `web_search` is registered in every session but was never in the default active tool
 * set, so the model could not see or call it. A backend nobody can reach is not a
 * feature: a real session enumerated its tools, found no search tool, and fell back to
 * driving `curl` through `bash`.
 *
 * Activation mirrors `lsp`, which joins the active set only when it is configured. The
 * tool stays registered either way, so an explicit `--tools web_search` still works and
 * the unconfigured error still explains itself.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("web_search activation", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `apex-web-search-activation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(webSearchOperations?: { search: () => Promise<never[]> }) {
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		return createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			...(webSearchOperations ? { webSearchOperations } : {}),
		});
	}

	it("leaves web_search inactive when no backend is configured", async () => {
		const { session } = await createSession();
		try {
			expect(session.getActiveToolNames()).not.toContain("web_search");
			// Registered but not active: an explicit --tools selection must still find it.
			expect(session.getAllTools().map((tool) => tool.name)).toContain("web_search");
		} finally {
			session.dispose();
		}
	});

	it("activates web_search once a backend is configured", async () => {
		const { session } = await createSession({ search: async () => [] });
		try {
			expect(session.getActiveToolNames()).toContain("web_search");
		} finally {
			session.dispose();
		}
	});

	it("keeps the four core tools active either way", async () => {
		const { session } = await createSession({ search: async () => [] });
		try {
			const active = session.getActiveToolNames();
			for (const name of ["read", "bash", "edit", "write"]) expect(active).toContain(name);
		} finally {
			session.dispose();
		}
	});
});
