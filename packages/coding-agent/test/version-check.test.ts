import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import {
	checkForNewApexCodeVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestApexCodeRelease,
	getLatestApexCodeVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewApexCodeVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewApexCodeVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the npm registry's next-tag endpoint for this package, with an apex-code user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestApexCodeVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`https://registry.npmjs.org/${PACKAGE_NAME}/next`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^apex-code\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestApexCodeRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewApexCodeVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("omits packageName when the registry's package name matches this package", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestApexCodeRelease("1.2.3")).resolves.toEqual({ version: "1.2.4" });
	});

	it("surfaces packageName when the registry reports a different published name", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: "apex-code-renamed", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestApexCodeRelease("1.2.3")).resolves.toEqual({
			packageName: "apex-code-renamed",
			version: "1.2.4",
		});
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewApexCodeVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestApexCodeVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
