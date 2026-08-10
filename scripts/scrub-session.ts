const REDACTED = "[REDACTED]";

type SecretKind = "provider-key" | "high-entropy-token" | "home-path" | "hostname" | "email";

export interface SecretFinding {
	kind: SecretKind;
	index: number;
	length: number;
}

interface SecretPattern {
	kind: Exclude<SecretKind, "high-entropy-token">;
	pattern: RegExp;
	replacement: string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
	{
		kind: "provider-key",
		pattern:
			/\b(?:tcb_ds_v1\.[A-Za-z0-9_-]+|sk-(?:live_[A-Za-z0-9_-]{16,}|proj-[A-Za-z0-9_-]{16,}|ant-api03-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{24,})|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{32,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
		replacement: REDACTED,
	},
	{
		kind: "provider-key",
		pattern: /\bBearer\s+[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/g,
		replacement: REDACTED,
	},
	{
		kind: "home-path",
		pattern: /\/(?:home|Users)\/[^/\s"\\]+/g,
		replacement: "$HOME",
	},
	{
		kind: "home-path",
		pattern: /\b[A-Za-z]:(?:(?:\\){1,2}|\/)(?:Users|users)(?:(?:\\){1,2}|\/)[^\\/\s"]+/g,
		replacement: "$HOME",
	},
	{
		kind: "email",
		pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
		replacement: REDACTED,
	},
	{
		kind: "hostname",
		pattern: /(?<![@A-Za-z0-9-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}\b/gi,
		replacement: REDACTED,
	},
	{
		kind: "hostname",
		pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
		replacement: REDACTED,
	},
];

const FILE_SUFFIXES = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "jsonl", "md", "txt", "yaml", "yml"]);
const HIGH_ENTROPY_CANDIDATE = /(?<![A-Za-z0-9+/])[A-Za-z0-9][A-Za-z0-9_+/=-]{31,}(?![A-Za-z0-9+/=])/g;
const TREE_IDENTIFIER = /("(?:id|parentId)"\s*:\s*)("(?:\\.|[^"\\])*")/g;

interface ProtectedInput {
	masked: string;
	restore: (scrubbed: string) => string;
}

function stateBefore(input: string, target: number): { depth: number; inString: boolean } {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < target; index++) {
		const character = input[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
		} else if (character === '"') inString = true;
		else if (character === "{") depth++;
		else if (character === "}") depth--;
	}
	return { depth, inString };
}

function protectTreeIdentifiers(input: string): ProtectedInput {
	const protectedValues: Array<{ identifier: string; placeholder: string }> = [];
	const ranges = Array.from(input.matchAll(TREE_IDENTIFIER))
		.filter((match) => {
			const state = stateBefore(input, match.index);
			return state.depth === 1 && !state.inString;
		})
		.map((match) => ({ start: match.index + match[1].length, end: match.index + match[0].length }));
	let masked = input;
	for (const range of ranges.reverse()) {
		const identifier = input.slice(range.start, range.end);
		const marker = `TREE-ID-${protectedValues.length}`;
		if (marker.length > identifier.length - 2) continue;
		const placeholder = `"${marker}${"~".repeat(identifier.length - marker.length - 2)}"`;
		protectedValues.push({ identifier, placeholder });
		masked = `${masked.slice(0, range.start)}${placeholder}${masked.slice(range.end)}`;
	}
	return {
		masked,
		restore: (scrubbed) =>
			protectedValues.reduce(
				(restored, { identifier, placeholder }) => restored.replace(placeholder, identifier),
				scrubbed,
			),
	};
}

function shannonEntropy(value: string): number {
	const counts = new Map<string, number>();
	for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

function isHighEntropyToken(value: string): boolean {
	return /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) && shannonEntropy(value) >= 3.5;
}

function isHostname(value: string): boolean {
	if (/^\d+$/.test(value)) return false;
	const suffix = value.slice(value.lastIndexOf(".") + 1).toLowerCase();
	return !FILE_SUFFIXES.has(suffix);
}

function replaceHighEntropyTokens(input: string): string {
	return input.replace(HIGH_ENTROPY_CANDIDATE, (candidate) => (isHighEntropyToken(candidate) ? REDACTED : candidate));
}

export function scrub(input: string): string {
	const { masked, restore } = protectTreeIdentifiers(input);
	const patterned = SECRET_PATTERNS.reduce((scrubbed, { pattern, replacement, kind }) => {
		if (kind === "hostname") return scrubbed.replace(pattern, (value) => (isHostname(value) ? replacement : value));
		return scrubbed.replace(pattern, replacement);
	}, masked);
	return restore(replaceHighEntropyTokens(patterned));
}

export function findSecrets(input: string): SecretFinding[] {
	const { masked } = protectTreeIdentifiers(input);
	const findings: SecretFinding[] = SECRET_PATTERNS.flatMap(({ kind, pattern }) =>
		Array.from(masked.matchAll(pattern), (match) => ({ kind, index: match.index, length: match[0].length })).filter(
			(finding) =>
				finding.kind !== "hostname" || isHostname(input.slice(finding.index, finding.index + finding.length)),
		),
	);
	for (const match of masked.matchAll(HIGH_ENTROPY_CANDIDATE)) {
		const end = match.index + match[0].length;
		const overlapsKnownFinding = findings.some(
			(finding) => match.index < finding.index + finding.length && end > finding.index,
		);
		if (isHighEntropyToken(match[0]) && !overlapsKnownFinding) {
			findings.push({ kind: "high-entropy-token", index: match.index, length: match[0].length });
		}
	}
	return findings.sort((left, right) => left.index - right.index);
}
