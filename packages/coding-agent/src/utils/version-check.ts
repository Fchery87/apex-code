import { compare, valid } from "semver";
import { PACKAGE_NAME } from "../config.ts";
import { getApexCodeUserAgent } from "./apex-code-user-agent.ts";
import { fetchWithRetry } from "./management-http.ts";

/**
 * npm's own per-tag registry endpoint, not a custom API this project would need to
 * host and operate. Compares against the "next" dist-tag rather than "latest": the
 * README documents `npm install --global apex-code@next` as the install channel
 * this pre-alpha project actually ships through.
 */
const LATEST_VERSION_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/next`;
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestApexCodeRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestApexCodeRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestApexCodeRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getApexCodeUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	// npm's per-tag registry endpoint returns the full package manifest for that
	// version; "packageName"/"note" have no npm-registry equivalent and are left
	// undefined -- callers already treat both as optional with sensible fallbacks.
	const data = (await response.json()) as {
		name?: unknown;
		version?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName = typeof data.name === "string" && data.name.trim() ? data.name.trim() : undefined;
	return {
		version: data.version.trim(),
		...(packageName && packageName !== PACKAGE_NAME ? { packageName } : {}),
	};
}

export async function getLatestApexCodeVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestApexCodeRelease(currentVersion, options))?.version;
}

export async function checkForNewApexCodeVersion(currentVersion: string): Promise<LatestApexCodeRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestApexCodeRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
