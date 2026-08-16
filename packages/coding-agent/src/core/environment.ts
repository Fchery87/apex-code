/** Canonical Apex Code environment compatibility boundary. */
export interface EnvironmentVariableSpec {
	readonly canonical: string;
	readonly legacy: string;
	readonly description: string;
}

export const APEX_ENVIRONMENT_VARIABLES = [
	["APEX_CODE_OFFLINE", "PI_OFFLINE", "Disable startup network operations"],
	["APEX_CODE_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK", "Skip the npm version check"],
	["APEX_CODE_PACKAGE_DIR", "PI_PACKAGE_DIR", "Override the package directory"],
	["APEX_CODE_EXPERIMENTAL", "PI_EXPERIMENTAL", "Enable experimental features"],
	["APEX_CODE_STARTUP_BENCHMARK", "PI_STARTUP_BENCHMARK", "Enable startup benchmarking"],
	["APEX_CODE_TIMING", "PI_TIMING", "Enable timing diagnostics"],
	["APEX_CODE_CLEAR_ON_SHRINK", "PI_CLEAR_ON_SHRINK", "Clear context on shrink"],
	["APEX_CODE_HARDWARE_CURSOR", "PI_HARDWARE_CURSOR", "Enable the hardware cursor"],
	["APEX_CODE_SHARE_VIEWER_URL", "PI_SHARE_VIEWER_URL", "Base URL for the share viewer"],
	["APEX_CODE_CODING_AGENT", "PI_CODING_AGENT", "Identify an Apex Code child process"],
	["APEX_CODE_SESSION_ID", "PI_SESSION_ID", "Current session identifier"],
	["APEX_CODE_SESSION_FILE", "PI_SESSION_FILE", "Current session file"],
	["APEX_CODE_PROVIDER", "PI_PROVIDER", "Current provider"],
	["APEX_CODE_MODEL", "PI_MODEL", "Current model"],
	["APEX_CODE_REASONING_LEVEL", "PI_REASONING_LEVEL", "Current reasoning level"],
] satisfies readonly (readonly [string, string, string])[];

const specs = new Map<string, EnvironmentVariableSpec>(
	APEX_ENVIRONMENT_VARIABLES.map(([canonical, legacy, description]) => [
		canonical,
		{ canonical, legacy, description },
	]),
);
const warned = new Set<string>();

function warn(spec: EnvironmentVariableSpec, conflict: boolean): void {
	const key = `${spec.canonical}:${conflict ? "conflict" : "legacy"}`;
	if (warned.has(key)) return;
	warned.add(key);
	console.error(
		`Apex Code: ${conflict ? `both ${spec.canonical} and legacy ${spec.legacy} are set; using ${spec.canonical}` : `${spec.legacy} is deprecated; use ${spec.canonical}`}.`,
	);
}

export function getApexEnvironment(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
	const spec = specs.get(name) ?? [...specs.values()].find((candidate) => candidate.legacy === name);
	if (!spec) return environment[name];
	const canonical = environment[spec.canonical];
	const legacy = environment[spec.legacy];
	if (canonical !== undefined) {
		if (legacy !== undefined && canonical !== legacy) warn(spec, true);
		return canonical;
	}
	if (legacy !== undefined) warn(spec, false);
	return legacy;
}

export function setApexEnvironment(
	name: string,
	value: string | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): void {
	const spec = specs.get(name) ?? [...specs.values()].find((candidate) => candidate.legacy === name);
	if (!spec) {
		if (value === undefined) delete environment[name];
		else environment[name] = value;
		return;
	}
	if (value === undefined) {
		delete environment[spec.canonical];
		delete environment[spec.legacy];
		return;
	}
	environment[spec.canonical] = value;
	environment[spec.legacy] = value;
}

export function setApexSubprocessEnvironment(
	environment: NodeJS.ProcessEnv,
	values: Partial<Record<string, string | undefined>>,
): void {
	for (const [name, value] of Object.entries(values)) setApexEnvironment(name, value, environment);
}

export function getApexEnvironmentSpecs(): readonly EnvironmentVariableSpec[] {
	return [...specs.values()];
}
