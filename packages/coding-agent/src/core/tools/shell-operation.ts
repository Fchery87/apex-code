/**
 * The one shell operation a set of tool arguments requests.
 *
 * The shell schema advertises a flat bag of fields because providers ignore
 * `anyOf` (see `toolUnion` in `contract.ts`). That advertisement cannot enforce
 * anything: a model may send any combination of fields, and it does. Consumers
 * that each re-read the raw bag disagreed about which operation a mixed call
 * requested — permissions keyed on `command`, execution keyed on `handle` — so
 * an allowed command could carry a denied background kill past the gate.
 *
 * Parse once, here, and let permissions, execution, display, and evidence all
 * read the same answer.
 */
export type ShellOperation =
	| { kind: "run"; command: string; timeout: number | undefined; background: boolean }
	| { kind: "retrieve"; handle: string }
	| { kind: "kill"; handle: string };

export type ShellOperationParse = { ok: true; operation: ShellOperation } | { ok: false; reason: string };

/**
 * Placeholder policy, stated once and applied everywhere.
 *
 * Models routinely populate every advertised field, sending `handle: ""` or
 * `timeout: null` beside a real command. A value that is absent, null, or an
 * empty string carries no request and is dropped. A value that would change
 * behaviour if honoured is never dropped: it either selects the operation or,
 * when it belongs to a different operation, makes the call ambiguous.
 */
function meaningful(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function presentString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

const RUN_HINT = "Supply `command` to run a command, or `handle` to retrieve or kill a background command.";

export function parseShellOperation(params: unknown): ShellOperationParse {
	if (typeof params !== "object" || params === null) {
		return { ok: false, reason: `Shell arguments must be an object. ${RUN_HINT}` };
	}
	const raw = params as Record<string, unknown>;
	const command = presentString(raw.command);
	const handle = presentString(raw.handle);
	const wantsKill = raw.kill === true;

	if (command !== undefined && handle !== undefined) {
		return {
			ok: false,
			reason: `Ambiguous shell call: \`command\` and \`handle\` request different operations. ${RUN_HINT} Send one, not both.`,
		};
	}

	if (handle !== undefined) {
		const stray: string[] = [];
		if (typeof raw.timeout === "number") stray.push("timeout");
		if (raw.background === true) stray.push("background");
		if (stray.length > 0) {
			return {
				ok: false,
				reason: `A background handle call takes only \`handle\` and optional \`kill\`. Remove: ${stray.join(", ")}.`,
			};
		}
		return { ok: true, operation: wantsKill ? { kind: "kill", handle } : { kind: "retrieve", handle } };
	}

	if (command !== undefined) {
		if (wantsKill) {
			return {
				ok: false,
				reason:
					"`kill: true` terminates a background command and requires its `handle`. It cannot be combined with `command`.",
			};
		}
		return {
			ok: true,
			operation: {
				kind: "run",
				command,
				timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
				background: raw.background === true,
			},
		};
	}

	return {
		ok: false,
		reason:
			"handle" in raw && !meaningful(raw.handle)
				? `\`handle\` is empty, which is not a background handle. ${RUN_HINT}`
				: `Shell call names no operation. ${RUN_HINT}`,
	};
}
