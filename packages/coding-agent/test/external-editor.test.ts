import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));

interface EditorCapture {
	argv: string[];
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

interface RunExternalEditorOptions {
	fixtureFlag?: "--fail" | "--empty";
	fixedArguments?: string[];
}

function quoteCommandArgument(argument: string): string {
	return `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function runExternalEditor(options: RunExternalEditorOptions = {}): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "apex external editor test "));
	const capturePath = join(testDirectory, "capture path with spaces.json");
	const executableDirectory = join(testDirectory, "editor executable path");
	symlinkSync(dirname(process.execPath), executableDirectory, process.platform === "win32" ? "junction" : "dir");
	const executablePath = join(executableDirectory, basename(process.execPath));
	const editorArguments = [
		editorFixturePath,
		capturePath,
		...(options.fixedArguments ?? []),
		...(options.fixtureFlag ? [options.fixtureFlag] : []),
	];
	try {
		const result = await editInExternalEditor({
			command: [executablePath, ...editorArguments].map(quoteCommandArgument).join(" "),
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("passes spaced paths and quoted arguments as exact argv", async () => {
		const fixedArguments = ["--fixed", "argument with spaces", 'quote"inside', "backslash\\inside", ""];
		const { result, capture } = await runExternalEditor({ fixedArguments });

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(capture.argv).toEqual([editorFixturePath, capture.argv[1], ...fixedArguments, capture.filePath]);
		expect(capture.argv[0]).toBe(editorFixturePath);
	});

	it("parses single quotes and unquoted backslash escapes", async () => {
		const testDirectory = mkdtempSync(join(tmpdir(), "apex-editor-parser-test-"));
		const capturePath = join(testDirectory, "capture.json");
		try {
			const result = await editInExternalEditor({
				command: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(editorFixturePath)} ${quoteCommandArgument(capturePath)} 'single quoted' escaped\\ space`,
				content: "original",
			});
			const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;

			expect(result).toEqual({ status: "complete", content: "edited" });
			expect(capture.argv).toEqual([
				editorFixturePath,
				capturePath,
				"single quoted",
				"escaped space",
				capture.filePath,
			]);
		} finally {
			rmSync(testDirectory, { recursive: true, force: true });
		}
	});

	it.each(["", "   ", '"unterminated', "'' argument"])("rejects invalid command %j", async (command) => {
		await expect(editInExternalEditor({ command, content: "original" })).resolves.toEqual({ status: "failed" });
	});

	it("edits a prompt inside a private Apex temporary directory and announces Apex resume identity", async () => {
		const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const { result, capture } = await runExternalEditor();
			const directory = dirname(capture.filePath);

			expect(result).toEqual({ status: "complete", content: "edited" });
			expect(dirname(directory)).toBe(tmpdir());
			expect(basename(directory)).toMatch(/^apex-code-editor-.+$/);
			expect(basename(capture.filePath)).toBe("prompt.md");
			expect(capture.entries).toEqual(["prompt.md"]);
			expect(capture.content).toBe("original");
			if (process.platform !== "win32") {
				expect(capture.directoryMode & 0o077).toBe(0);
			}
			expect(existsSync(directory)).toBe(false);
			expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Apex Code will resume when the editor exits."));
		} finally {
			writeSpy.mockRestore();
		}
	});

	it("returns failed when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor({ fixtureFlag: "--fail" });

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});

	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor({ fixtureFlag: "--empty" });

		expect(result).toEqual({ status: "complete", content: "" });
	});
});
