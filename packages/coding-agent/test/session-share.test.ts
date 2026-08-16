import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishSessionShare } from "../src/core/session-share.ts";

afterEach(() => vi.restoreAllMocks());

describe("session sharing", () => {
	it("does not export or publish before affirmative confirmation", async () => {
		const exportToHtml = vi.fn();
		const publishGist = vi.fn();
		await expect(publishSessionShare({ confirm: async () => false, exportToHtml, publishGist })).resolves.toEqual({
			kind: "cancelled",
		});
		expect(exportToHtml).not.toHaveBeenCalled();
		expect(publishGist).not.toHaveBeenCalled();
	});

	it("publishes the exact export from an unpredictable directory and cleans it", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "apex-code-share-test-"));
		try {
			let publishedPath = "";
			const result = await publishSessionShare({
				confirm: async () => true,
				temporaryRoot,
				exportToHtml: async (path) => {
					await writeFile(path, "complete session");
				},
				publishGist: async (path) => {
					publishedPath = path;
					expect(await readFile(path, "utf8")).toBe("complete session");
					return "https://gist.github.com/user/gist-id";
				},
			});

			expect(result).toEqual({
				kind: "published",
				gistUrl: "https://gist.github.com/user/gist-id",
				gistId: "gist-id",
			});
			expect(publishedPath).toContain(join(temporaryRoot, "apex-code-share-"));
			await expect(access(publishedPath)).rejects.toThrow();
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("cleans the private export after publication fails", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "apex-code-share-test-"));
		let exportPath = "";
		try {
			await expect(
				publishSessionShare({
					confirm: async () => true,
					temporaryRoot,
					exportToHtml: async (path) => {
						exportPath = path;
						await writeFile(path, "sensitive session");
					},
					publishGist: async () => {
						throw new Error("GitHub rejected the upload");
					},
				}),
			).rejects.toThrow("GitHub rejected the upload");
			await expect(access(exportPath)).rejects.toThrow();
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});
});
