const PREFER_STRICT_TOOL_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

export function areExperimentalFeaturesEnabled(): boolean {
	return getApexEnvironment("APEX_CODE_EXPERIMENTAL") === "1";
}

import { getApexEnvironment } from "./environment.ts";

export function getExperimentalToolSampling() {
	return areExperimentalFeaturesEnabled() ? PREFER_STRICT_TOOL_SAMPLING : undefined;
}
