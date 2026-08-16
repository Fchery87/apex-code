export function areExperimentalFeaturesEnabled(): boolean {
	return getApexEnvironment("APEX_CODE_EXPERIMENTAL") === "1";
}

import { getApexEnvironment } from "./environment.ts";
