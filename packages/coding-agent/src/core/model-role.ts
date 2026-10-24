import type { Model } from "@earendil-works/pi-ai/compat";

/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 4. A configured role wins.
 * A missing or empty role is the session model, never an error.
 */
export function modelForRole(
	sessionModel: Model<any>,
	roles: ReadonlyMap<string, readonly Model<any>[]> | undefined,
	roleName: string,
): Model<any> {
	const candidates = roles?.get(roleName);
	return candidates && candidates.length > 0 ? candidates[0] : sessionModel;
}
