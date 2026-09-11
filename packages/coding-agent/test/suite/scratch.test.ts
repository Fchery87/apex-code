import * as promises from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rmScratchResilient, scratchDir } from "./scratch.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

describe("scratch cleanup", () => {
	it("removes a scratch tree and tolerates repeated cleanup", async () => {
		const root = await scratchDir("apex-scratch-cleanup-");
		await promises.mkdir(join(root, "nested"));
		await promises.writeFile(join(root, "nested", "file.txt"), "scratch");
		await rmScratchResilient(root);
		await expect(promises.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
		await rmScratchResilient(root);
	});

	it.each(["EBUSY", "EACCES"])("reports terminal %s errors", async (code) => {
		const failure = Object.assign(new Error("cleanup failed"), { code });
		const asyncRemoval = vi.spyOn(promises, "rm").mockRejectedValue(failure);
		try {
			await expect(Promise.resolve().then(() => rmScratchResilient("unused-scratch-path"))).rejects.toBe(failure);
		} finally {
			asyncRemoval.mockRestore();
		}
	});
});
