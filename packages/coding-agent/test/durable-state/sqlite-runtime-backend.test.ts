/**
 * Pins the runtime-aware sqlite backend in `durable-state/sqlite.ts`.
 *
 * `bun build --compile` bundles this module into the standalone release binary, and Bun does
 * not implement `node:sqlite` at all -- not under `bun run`, not compiled. A plain, static
 * `import { DatabaseSync } from "node:sqlite"` therefore builds and passes the entire test
 * suite under `npm test` (which always runs under Node) while silently breaking the compiled
 * binary: the regression is invisible to typecheck, lint, and the normal test run alike, and
 * only shows up when someone actually runs `bun build --compile` against this module, which
 * is exactly what the release workflow's "Smoke test local standalone binary" step does.
 *
 * The source-shape tests below pin the two things that made the fix work (a type-only import
 * of `node:sqlite`, and resolving the real binding through `createRequire` with a
 * runtime-computed specifier rather than a literal `require`/`import()`) so a future refactor
 * that reintroduces a static value import fails here instead of in a release. The behavioral
 * test actually compiles a standalone bun binary against this module and runs it, which is
 * the only way to prove the bundler doesn't choke on it -- it's skipped where `bun` isn't on
 * PATH, since only the release workflow's runners are guaranteed to have it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const sqliteModuleUrl = new URL("../../src/core/durable-state/sqlite.ts", import.meta.url);
const sqliteModulePath = fileURLToPath(sqliteModuleUrl);
const sqliteSource = readFileSync(sqliteModulePath, "utf8");

function bunAvailable(): boolean {
	return spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable-state sqlite backend selection", () => {
	it("imports node:sqlite only as a type, never as a static value import", () => {
		expect(sqliteSource).toMatch(/^import type \{ DatabaseSync \} from "node:sqlite";/m);
		expect(sqliteSource).not.toMatch(/^import \{[^}]*\} from "node:sqlite";/m);
		expect(sqliteSource).not.toMatch(/^import \{[^}]*\} from "bun:sqlite";/m);
	});

	it("resolves the real binding through createRequire with a runtime-computed specifier", () => {
		// A literal `require("node:sqlite")`/`require("bun:sqlite")` reachable from a bundler's
		// static import graph, or a dynamic `import()` of either (even behind a runtime branch),
		// is exactly what a bundler resolves eagerly and is what broke the compiled binary
		// during development. Only a call through the local `requireSqliteModule` binding --
		// itself the result of `createRequire`, not the ambient `require` -- avoids that.
		expect(sqliteSource).toMatch(/const requireSqliteModule = createRequire\(import\.meta\.url\);/);
		expect(sqliteSource).toMatch(/requireSqliteModule\("bun:sqlite"\)/);
		expect(sqliteSource).toMatch(/requireSqliteModule\("node:sqlite"\)/);
		expect(sqliteSource).not.toMatch(/[^.]import\(\s*["'](?:bun|node):sqlite["']\s*\)/);
	});

	it("picks bun:sqlite only when running under Bun", () => {
		expect(sqliteSource).toMatch(/typeof \(globalThis as \{ Bun\?: unknown \}\)\.Bun !== "undefined"/);
	});

	it.skipIf(!bunAvailable())(
		"builds and runs a standalone bun binary that exercises the real bun:sqlite backend",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "apex-bun-sqlite-smoketest-"));
			tempDirs.push(dir);
			const harnessPath = join(dir, "harness.ts");
			const databasePath = join(dir, "state.sqlite");
			const outfile = join(dir, "harness-bin");
			writeFileSync(
				harnessPath,
				[
					`import { openDurableStateStore } from ${JSON.stringify(sqliteModulePath)};`,
					`const store = openDurableStateStore(${JSON.stringify(databasePath)});`,
					`if (store.schemaVersion() !== 4) throw new Error("unexpected schema version: " + store.schemaVersion());`,
					`store.beginCommand({ id: "cmd-1", sessionId: "s1", command: "echo hi" });`,
					`store.transitionCommand("cmd-1", "running");`,
					`const done = store.transitionCommand("cmd-1", "completed");`,
					`if (done.state !== "completed") throw new Error("transition did not complete");`,
					`store.close();`,
					`console.log("OK");`,
				].join("\n"),
			);

			// Mirrors scripts/build-binaries.sh's actual `bun build --compile` invocation closely
			// enough to exercise the same bundler resolution path this module has to survive.
			execFileSync(
				"bun",
				["build", "--compile", "--no-compile-autoload-bunfig", harnessPath, "--outfile", outfile],
				{ stdio: "pipe" },
			);
			const output = execFileSync(outfile, { encoding: "utf8" });
			expect(output.trim()).toBe("OK");
		},
	);
});
