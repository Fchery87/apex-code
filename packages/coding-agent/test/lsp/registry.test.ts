import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type LspSettings, resolveLspRegistry, selectLspServerForPath } from "../../src/core/lsp/registry.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-lsp-registry-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function executable(directory: string, name = process.platform === "win32" ? "server.CMD" : "server"): string {
	const path = join(directory, name);
	writeFileSync(path, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
	if (process.platform !== "win32") chmodSync(path, 0o755);
	return path;
}

function settings(command: string): LspSettings {
	return {
		typescript: {
			command,
			languages: [{ languageId: "typescript", extensions: [".ts", ".d.ts"], filenames: ["special"] }],
			rootMarkers: ["tsconfig.json", "package.json"],
		},
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("LSP registry", () => {
	test("resolves a bare command from PATH and freezes its absolute path", () => {
		const workspace = temporaryDirectory();
		const bin = temporaryDirectory();
		const server = executable(bin);
		const registry = resolveLspRegistry(settings(basename(server)), {
			workspace,
			env: { PATH: [bin, "/unsearched"].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" },
		});

		expect(registry.servers[0]?.command).toBe(server);
	});

	test("rejects relative executable paths and ambiguous language matchers", () => {
		const workspace = temporaryDirectory();
		expect(() => resolveLspRegistry(settings(`.${join("bin", "server")}`), { workspace })).toThrow(
			"must be a bare executable name or an absolute path",
		);

		const server = executable(temporaryDirectory());
		expect(() =>
			resolveLspRegistry(
				{
					one: settings(server).typescript,
					two: { command: server, languages: [{ languageId: "other", extensions: [".ts"] }] },
				},
				{ workspace },
			),
		).toThrow("ambiguous matcher");
	});

	test("selects exact filename before longest suffix and the nearest root marker", () => {
		const workspace = temporaryDirectory();
		const nested = join(workspace, "packages", "app", "src");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(workspace, "package.json"), "{}");
		writeFileSync(join(workspace, "packages", "app", "tsconfig.json"), "{}");
		const special = join(nested, "special");
		const declaration = join(nested, "types.d.ts");
		writeFileSync(special, "");
		writeFileSync(declaration, "");
		const server = executable(temporaryDirectory());
		const registry = resolveLspRegistry(settings(server), { workspace });

		expect(selectLspServerForPath(registry, special)).toMatchObject({
			languageId: "typescript",
			root: join(workspace, "packages", "app"),
		});
		expect(selectLspServerForPath(registry, declaration)).toMatchObject({ languageId: "typescript" });
	});

	test("rejects a canonical path that escapes the workspace through a symlink", () => {
		if (process.platform === "win32") return;
		const workspace = temporaryDirectory();
		const outside = temporaryDirectory();
		const server = executable(temporaryDirectory());
		writeFileSync(join(outside, "escape.ts"), "");
		symlinkSync(outside, join(workspace, "linked"));
		const registry = resolveLspRegistry(settings(server), { workspace });

		expect(() => selectLspServerForPath(registry, join(workspace, "linked", "escape.ts"))).toThrow(
			"outside the LSP workspace",
		);
	});
});
