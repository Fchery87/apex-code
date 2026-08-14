import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager delegation depth (task 5.3)", () => {
	it("defaults to depth 0 when newSession is not given a delegationDepth", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		expect(session.getHeader()?.delegationDepth).toBeUndefined();
		expect(session.getDelegationDepth()).toBe(0);
	});

	it("records the delegationDepth passed to newSession, and reads it back", () => {
		const session = SessionManager.inMemory();
		session.newSession({ delegationDepth: 2 });
		expect(session.getHeader()?.delegationDepth).toBe(2);
		expect(session.getDelegationDepth()).toBe(2);
	});

	it("records delegationDepth when passed directly to the inMemory constructor", () => {
		const session = SessionManager.inMemory(process.cwd(), { delegationDepth: 1, parentSession: "parent-id" });
		expect(session.getHeader()?.delegationDepth).toBe(1);
		expect(session.getHeader()?.parentSession).toBe("parent-id");
		expect(session.getDelegationDepth()).toBe(1);
	});

	it("a session written without the field (pre-task-5.3) reads back as depth 0, not undefined behavior", () => {
		// newSession() with no options at all is exactly what every session created
		// before this task looks like -- additive/optional per contracts.md §3.
		const session = SessionManager.inMemory();
		session.newSession({ id: "legacy-session" });
		expect(session.getDelegationDepth()).toBe(0);
	});
});
