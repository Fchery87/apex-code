import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * VF.4 session integration (spec
 * 2026-09-01-configured-verification-and-formatting.md § 4): the public
 * session boundary — requestVerification, verificationStatus, the
 * configured post-turn boundary, staleness after a real workspace change,
 * and continue-without-verification. Settings come from real files in a
 * scratch directory so the trust and precedence path is exercised, not
 * bypassed.
 */

const directories: string[] = [];

let currentTempDir: string | undefined;
let currentRuntime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;

afterEach(async () => {
	if (currentRuntime !== undefined) {
		await currentRuntime.dispose();
		currentRuntime = undefined;
	}
	if (currentTempDir !== undefined) {
		rmSync(currentTempDir, { recursive: true, force: true });
		currentTempDir = undefined;
	}
});

interface SessionUnderTest {
	session: AgentSession;
	tempDir: string;
	settingsPath: string;
}

async function createVerifiedSession(settings: unknown): Promise<SessionUnderTest> {
	const tempDir = mkdtempSync(join(tmpdir(), "apex-vf4-"));
	currentTempDir = tempDir;
	directories.push(tempDir);
	mkdirSync(join(tempDir, "sessions"), { recursive: true });
	execFileSync("git", ["init", "-b", "main", tempDir]);
	execFileSync("git", ["-C", tempDir, "config", "user.email", "vf4@example.com"]);
	execFileSync("git", ["-C", tempDir, "config", "user.name", "vf4"]);
	writeFileSync(join(tempDir, "tracked.txt"), "seed\n", "utf-8");
	execFileSync("git", ["-C", tempDir, "add", "-A"]);
	execFileSync("git", ["-C", tempDir, "commit", "-m", "initial"]);
	writeFileSync(join(tempDir, "settings.json"), JSON.stringify(settings), "utf-8");

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager: manager }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: manager,
				tools: [],
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager,
	});
	const session = runtimeHost.session;
	mockTurn(session);
	return { session, tempDir, settingsPath: join(tempDir, "settings.json") };
}

function passPolicy(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		executable: process.execPath,
		argv: ["-e", "process.exit(0)"],
		...overrides,
	};
}

function mockTurn(target: AgentSession): void {
	const turnModel = target.model!;
	// The mocked turn never reaches a provider, so the auth gate prompt()
	// runs before streaming is satisfied locally: the harness-supplied
	// runtime is told the provider is configured.
	const modelRuntime = (target as unknown as { _modelRuntime: { hasConfiguredAuth: (provider: string) => boolean } })
		._modelRuntime;
	modelRuntime.hasConfiguredAuth = () => true;
	target.agent.streamFunction = () => {
		const stream = createAssistantMessageEventStream();
		void Promise.resolve().then(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("Done."),
					api: turnModel.api,
					provider: turnModel.provider,
					model: turnModel.id,
					usage: {
						input: 10,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 10,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} satisfies AssistantMessage,
			});
		});
		return stream;
	};
}

describe("session verification lifecycle (VF.4)", () => {
	it("is unavailable when nothing is configured", async () => {
		const { session } = await createVerifiedSession({});
		expect(await session.requestVerification()).toBe("unavailable");
		expect(session.verificationStatus()).toBe("unavailable");
	});

	it("runs an explicit passing policy and reports verified", async () => {
		const { session } = await createVerifiedSession({
			policies: { schemaVersion: 1, verification: [passPolicy("typecheck")] },
		});
		expect(await session.requestVerification()).toBe("verified");
		expect(session.verificationStatus()).toBe("verified");
		const record = session.verificationRecord();
		expect(record?.outcome).toBe("verified");
		expect(record?.evidence[0].policyId).toBe("typecheck");
		expect(record?.evidence[0].status).toBe("passed");
	});

	it("reports a failing blocking policy as failed, never verified", async () => {
		const { session } = await createVerifiedSession({
			policies: {
				schemaVersion: 1,
				verification: [passPolicy("typecheck", { argv: ["-e", "process.exit(1)"], blocksCompletion: true })],
			},
		});
		expect(await session.requestVerification()).toBe("failed");
		expect(session.verificationStatus()).toBe("failed");
		expect(session.verificationRecord()?.outcome).toBe("failed");
		expect(session.verificationRecord()?.evidence[0].exitCode).toBe(1);
	});

	it("retires the result after a real workspace change and a following turn", async () => {
		const { session, tempDir } = await createVerifiedSession({
			policies: { schemaVersion: 1, verification: [passPolicy("typecheck")] },
		});
		await session.requestVerification();
		expect(session.verificationStatus()).toBe("verified");

		writeFileSync(join(tempDir, "changed-after-verify.txt"), "mutated", "utf-8");
		await session.prompt("carry on");
		expect(session.verificationStatus()).toBe("unavailable");
	});

	it("keeps the result across a turn when the workspace did not change", async () => {
		const { session } = await createVerifiedSession({
			policies: { schemaVersion: 1, verification: [passPolicy("typecheck")] },
		});
		await session.requestVerification();
		await session.prompt("carry on");
		expect(session.verificationStatus()).toBe("verified");
	});

	it("runs a post-turn boundary automatically after a completed turn", async () => {
		const { session } = await createVerifiedSession({
			policies: {
				schemaVersion: 1,
				boundary: "post-turn",
				verification: [passPolicy("typecheck")],
			},
		});
		expect(session.verificationStatus()).toBe("unavailable");
		await session.prompt("carry on");
		expect(session.verificationStatus()).toBe("verified");
		expect(session.verificationRecord()?.evidence[0].policyId).toBe("typecheck");
	});

	it("reports continued-unverified as its own status", async () => {
		const { session } = await createVerifiedSession({
			policies: { schemaVersion: 1, verification: [passPolicy("typecheck")] },
		});
		session.continueWithoutVerification();
		expect(session.verificationStatus()).toBe("continued-unverified");
	});
});

describe("session formatter lifecycle (VF.5)", () => {
	it("runs a configured formatter and reports its mutations", async () => {
		const { session, tempDir } = await createVerifiedSession({
			policies: {
				schemaVersion: 1,
				formatter: [
					{
						id: "format",
						executable: process.execPath,
						argv: ["-e", `require("fs").writeFileSync("src/f.ts", "formatted")`],
						cwd: "workspace",
						declaredPaths: ["src/**/*.ts"],
					},
				],
			},
		});
		mkdirSync(join(tempDir, "src"), { recursive: true });
		writeFileSync(join(tempDir, "src", "f.ts"), "raw", "utf-8");
		const outcome = await session.runConfiguredFormatter();
		expect(outcome?.status).toBe("passed");
		expect(outcome?.mutations.changedPaths).toEqual(["src/f.ts"]);
		expect(outcome?.mutations.undeclaredPaths).toEqual([]);
	});

	it("returns undefined when no formatter policy matches", async () => {
		const { session } = await createVerifiedSession({
			policies: { schemaVersion: 1, verification: [passPolicy("typecheck")] },
		});
		expect(await session.runConfiguredFormatter()).toBeUndefined();
		expect(await session.runConfiguredFormatter({ policyId: "nope" })).toBeUndefined();
	});

	it("retires a verified status when the formatter mutates the workspace", async () => {
		const { session, tempDir } = await createVerifiedSession({
			policies: {
				schemaVersion: 1,
				verification: [passPolicy("typecheck")],
				formatter: [
					{
						id: "format",
						executable: process.execPath,
						argv: ["-e", `require("fs").writeFileSync("src/g.ts", "formatted")`],
						cwd: "workspace",
						declaredPaths: ["src/**/*.ts"],
					},
				],
			},
		});
		mkdirSync(join(tempDir, "src"), { recursive: true });
		writeFileSync(join(tempDir, "src", "g.ts"), "raw", "utf-8");
		await session.requestVerification();
		expect(session.verificationStatus()).toBe("verified");
		await session.runConfiguredFormatter();
		expect(session.verificationStatus()).toBe("unavailable");
	});
});
