import { describe, expect, test } from "vitest";
import { LspStatusStore } from "../../src/core/lsp/status.ts";

describe("LspStatusStore", () => {
	test("retains a bounded chronological tail and latest state per server root", () => {
		const store = new LspStatusStore({ capacity: 2 });
		store.record({ serverId: "ts", root: "/one", state: "starting", attempt: 1 });
		store.record({ serverId: "ts", root: "/one", state: "ready", attempt: 1 });
		store.record({ serverId: "py", root: "/two", state: "disabled", attempt: 3, reason: "crashed" });

		expect(store.list().map(({ state }) => state)).toEqual(["ready", "disabled"]);
		expect(store.latest("ts", "/one")).toMatchObject({ state: "ready", attempt: 1 });
		expect(store.totalCount).toBe(3);
	});
});
