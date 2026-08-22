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

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	delete process.env.APEX_TEST_FAKE_API_KEY;
	delete process.env.APEX_TEST_FAKE_BASE_URL;
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
