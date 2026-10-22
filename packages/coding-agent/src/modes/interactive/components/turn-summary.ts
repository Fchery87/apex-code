import { Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type TurnSummaryOutcome = "completed" | "aborted";

export interface TurnChange {
	files: number;
	added: number;
	removed: number;
}

export class TurnSummaryComponent extends Text {
	constructor(elapsedMs: number, outcome: TurnSummaryOutcome, change?: TurnChange) {
		const seconds = Math.floor(elapsedMs / 1000);
		const minutes = Math.floor(seconds / 60);
		const duration = minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
		const label = outcome === "aborted" ? "Interrupted after" : "Worked for";
		const counts =
			change && change.files > 0
				? `${change.files} ${change.files === 1 ? "file" : "files"} +${change.added} -${change.removed}`
				: "";
		const text = counts ? `${counts} · ${label.toLowerCase()} ${duration}` : `${label} ${duration}`;
		super(seconds < 1 ? "" : theme.fg("dim", text), 1, 0);
	}
}
