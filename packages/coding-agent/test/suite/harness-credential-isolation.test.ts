/**
 * A suite harness must see no ambient provider credentials.
 *
 * Without this, a developer's own exported keys reach the model registry, which counts
 * their providers as configured alongside the harness's single faux one. Regression
 * `7209` failed exactly that way for months of developer-machine runs while staying
 * green in CI, and presented as an unrelated model-selector bug.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

/** Every variable this file sets by hand; the harness restores only what it scrubbed. */
const MANUALLY_SET_ENVIRONMENT_VARIABLES = [
	"APEX_TEST_FAKE_API_KEY",
	"APEX_TEST_FAKE_BASE_URL",
	"HF_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const name of MANUALLY_SET_ENVIRONMENT_VARIABLES) delete process.env[name];
});

describe("suite harness credential isolation", () => {
	it("hides ambient provider credentials from the session under test", async () => {
		process.env.APEX_TEST_FAKE_API_KEY = "leaked-key";
		process.env.APEX_TEST_FAKE_BASE_URL = "https://leaked.example.com";

		const harness = await createHarness();
		harnesses.push(harness);

		expect(process.env.APEX_TEST_FAKE_API_KEY).toBeUndefined();
		expect(process.env.APEX_TEST_FAKE_BASE_URL).toBeUndefined();
	});

	it("restores the developer's environment on cleanup", async () => {
		process.env.APEX_TEST_FAKE_API_KEY = "leaked-key";

		const harness = await createHarness();
		harness.cleanup();

		// Leaving a developer's shell scrubbed would be its own surprising bug.
		expect(process.env.APEX_TEST_FAKE_API_KEY).toBe("leaked-key");
	});

	it("leaves unrelated variables untouched", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(process.env.PATH).toBeDefined();
	});
});

describe("suite harness credential isolation breadth", () => {
	/**
	 * `7209` was a Google key, but the registry reads credential sources whose names do
	 * not end in the scrubbed suffixes. Each of these would make a second provider count
	 * as configured on a developer's machine exactly the way `GEMINI_API_KEY` did --
	 * the registry answers "<authenticated>" or a key for them, so the faux-only
	 * assumption breaks the same way. The source of truth for this list is
	 * `getEnvApiKey` in `packages/ai/src/env-api-keys.ts`; a new provider credential
	 * variable belongs here the day it is added there.
	 */
	it("hides provider credential variables that match no scrubbed suffix", async () => {
		process.env.HF_TOKEN = "leaked-token";
		process.env.COPILOT_GITHUB_TOKEN = "leaked-token";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/home/leaked/adc.json";
		process.env.GOOGLE_CLOUD_PROJECT = "leaked-project";
		process.env.GOOGLE_CLOUD_LOCATION = "leaked-location";
		process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/leaked";
		process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = "https://leaked.example.com";
		process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/home/leaked/web-identity";

		const harness = await createHarness();
		harnesses.push(harness);

		for (const name of [
			"HF_TOKEN",
			"COPILOT_GITHUB_TOKEN",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"GOOGLE_CLOUD_PROJECT",
			"GOOGLE_CLOUD_LOCATION",
			"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
			"AWS_CONTAINER_CREDENTIALS_FULL_URI",
			"AWS_WEB_IDENTITY_TOKEN_FILE",
		]) {
			expect(process.env[name], name).toBeUndefined();
		}
	});
});
