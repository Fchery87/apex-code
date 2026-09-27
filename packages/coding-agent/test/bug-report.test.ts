import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	BUG_REPORT_CUSTOM_ENTRY_TYPE,
	bugReportArchiveFileName,
	collectBugReportMetadata,
	redactJsonValue,
	redactUrl,
} from "../src/core/bug-report.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { Settings } from "../src/core/settings-manager.ts";
import { getApexCodeUserAgent } from "../src/utils/apex-code-user-agent.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("bug report redaction", () => {
	it("removes URL credentials and secret query parameters", () => {
		expect(redactUrl("https://user:pass@proxy.example.com:8080/")).toBe("https://proxy.example.com:8080/");
		expect(redactUrl("git:https://pat@github.com/org/repo")).toBe("git:https://github.com/org/repo");
		expect(redactUrl("https://api.example/v1?api-key=abc&model=x")).toBe(
			"https://api.example/v1?api-key=%3Credacted%3E&model=x",
		);
	});

	it("redacts nested secret values without hiding token counts", () => {
		expect(
			redactJsonValue({
				apiKey: "sk-123",
				headers: { Authorization: "Bearer x", "X-Trace": "1" },
				compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
				baseUrl: "https://me:secret@example.com/",
			}),
		).toEqual({
			apiKey: "<redacted>",
			headers: { Authorization: "<redacted>", "X-Trace": "1" },
			compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
			baseUrl: "https://example.com/",
		});
	});

	it("uses Apex identity in exported report metadata", () => {
		vi.stubEnv("APEX_CODE_TEST_FLAG", "1");
		vi.stubEnv("PI_TEST_FLAG", "1");
		const metadata = collectBugReportMetadata({
			id: "report-id",
			sessionId: "session-id",
			cwd: "/tmp/project",
			includeSession: false,
			includeSummary: false,
			messageCount: 2,
			modelRuntime: {} as ModelRuntime,
			thinkingLevel: "off",
			extensions: [],
			extensionErrors: [],
			globalSettings: {} as Settings,
			projectSettings: {} as Settings,
		});

		expect(metadata.environment.userAgent).toBe(getApexCodeUserAgent(VERSION));
		expect(metadata.environment.apexCodeEnvironmentVariables).toContain("APEX_CODE_TEST_FLAG");
		expect(metadata.environment.apexCodeEnvironmentVariables).not.toContain("PI_TEST_FLAG");
		expect(BUG_REPORT_CUSTOM_ENTRY_TYPE).toBe("apex-code.bug-report");
		expect(bugReportArchiveFileName("report-id")).toBe("apex-code-bug-report-report-id.zip");
	});
});
