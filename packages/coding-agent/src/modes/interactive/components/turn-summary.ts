import { Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type TurnSummaryOutcome = "completed" | "aborted";

export class TurnSummaryComponent extends Text {
	constructor(elapsedMs: number, outcome: TurnSummaryOutcome) {
		const seconds = Math.floor(elapsedMs / 1000);
		const minutes = Math.floor(seconds / 60);
		const duration = minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
		const label = outcome === "aborted" ? "Interrupted after" : "Worked for";
		super(seconds < 1 ? "" : theme.fg("dim", `${label} ${duration}`), 1, 0);
	}
}
