import { describe, expect, it } from "vitest";
import { FileReadLedger } from "../../src/core/tools/file-ledger.ts";

describe("read ledger (HR.24)", () => {
	it("a new file needs no read before write", () => {
		expect(new FileReadLedger().checkWrite("/w/new.txt", undefined)).toBeUndefined();
	});

	it("write refuses an existing file the model never read", () => {
		expect(new FileReadLedger().checkWrite("/w/a.txt", "old")).toMatch(/has not been read/);
	});

	it("write allows a file read in full and unchanged since", () => {
		const ledger = new FileReadLedger();
		ledger.recordRead("/w/a.txt", "old", true);
		expect(ledger.checkWrite("/w/a.txt", "old")).toBeUndefined();
	});

	it("write refuses after a partial read, though edit still allows it", () => {
		const ledger = new FileReadLedger();
		ledger.recordRead("/w/a.txt", "old", false);
		expect(ledger.checkWrite("/w/a.txt", "old")).toMatch(/only part of the file was read/);
		expect(ledger.checkEdit("/w/a.txt", "old")).toBeUndefined();
	});

	it("write and edit both refuse a file changed on disk since the read", () => {
		const ledger = new FileReadLedger();
		ledger.recordRead("/w/a.txt", "old", true);
		expect(ledger.checkWrite("/w/a.txt", "changed by someone else")).toMatch(/changed on disk/);
		expect(ledger.checkEdit("/w/a.txt", "changed by someone else")).toMatch(/changed on disk/);
	});

	it("a write the model made counts as knowing the file", () => {
		const ledger = new FileReadLedger();
		ledger.recordWrite("/w/a.txt", "fresh");
		expect(ledger.checkWrite("/w/a.txt", "fresh")).toBeUndefined();
	});
});
