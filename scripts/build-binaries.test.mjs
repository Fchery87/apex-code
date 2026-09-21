import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("./build-binaries.sh", import.meta.url);
const rootTsconfigUrl = new URL("../tsconfig.json", import.meta.url);

test("the root tsconfig's highlight.js mappings stay type-only", async () => {
	const tsconfig = JSON.parse((await readFile(rootTsconfigUrl, "utf8")).replace(/^\s*\/\/.*$/gm, ""));
	const mappings = Object.entries(tsconfig.compilerOptions.paths).filter(([specifier]) =>
		specifier.startsWith("highlight.js"),
	);

	// These exist so highlight.js's own types -- which open with `/// <reference lib="dom" />`
	// -- never enter the program and never break frozen packages/ai. Pointing one at a .ts
	// file would make it a runtime redirect as well, which is a different and much larger
	// claim than the one intended here.
	assert.ok(mappings.length > 0, "expected the highlight.js type-only mappings");
	for (const [specifier, targets] of mappings) {
		for (const target of targets) {
			assert.ok(target.endsWith(".d.ts"), `${specifier} must map to a .d.ts, got ${target}`);
		}
	}
});

test("the binary build stops Bun's tsconfig search before the repository root", async () => {
	const source = await readFile(scriptUrl, "utf8");

	// Bun's bundler honors tsconfig `paths` and has no notion of a type-only redirect, so
	// without this it resolves `highlight.js/lib/core` to the declaration file above and
	// bundles it as runtime code. `declare const hljs` emits nothing, and the compiled
	// binary dies on startup with `ReferenceError: hljs is not defined`.
	const writeIndex = source.indexOf("> ./dist/tsconfig.json");
	assert.notEqual(writeIndex, -1, "build-binaries.sh must write ./dist/tsconfig.json");

	const firstBunBuild = source.indexOf("bun build --compile");
	assert.notEqual(firstBunBuild, -1, "expected a bun build --compile invocation");
	assert.ok(writeIndex < firstBunBuild, "the tsconfig must be written before the first bun build");
});
