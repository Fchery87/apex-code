import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentToolCall } from "./types.ts";

const MAX_IDENTICAL_FAILURES = 3;
const MAX_TRACKED_FAILURES = 64;

/** Track identical failed calls between successful work or new user input. */
export class RepeatedToolErrors {
	private readonly counts = new Map<string, number>();

	reset(): void {
		this.counts.clear();
	}

	record(calls: AgentToolCall[], results: ToolResultMessage[]): boolean {
		if (results.some((result) => !result.isError)) {
			this.reset();
			return false;
		}
		let repeated = false;
		for (const result of results) {
			const call = calls.find((call) => call.id === result.toolCallId);
			if (!call) continue;
			const key = signature(call, result);
			const count = (this.counts.get(key) ?? 0) + 1;
			this.counts.set(key, count);
			if (count >= MAX_IDENTICAL_FAILURES) repeated = true;
			if (this.counts.size > MAX_TRACKED_FAILURES) {
				const oldest = this.counts.keys().next();
				if (!oldest.done) this.counts.delete(oldest.value);
			}
		}
		return repeated;
	}
}

function signature(call: AgentToolCall, result: ToolResultMessage): string {
	return JSON.stringify([call.name, call.arguments, result.content], (_key, value: unknown) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
	});
}
