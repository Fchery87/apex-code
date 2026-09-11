import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("local release restores pinned model data before building, including when checks are skipped", () => {
	const scratch = mkdtempSync(join(tmpdir(), "apex-local-release-test-"));
	try {
		const workspace = join(scratch, "workspace");
		mkdirSync(workspace);
		writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "pi-monorepo" }));
		const preload = join(scratch, "stop-command.mjs");
		writeFileSync(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawnSync = () => ({ status: 42 });
syncBuiltinESMExports();
`);
		const result = spawnSync(process.execPath, [
			"--import", preload,
			fileURLToPath(new URL("./local-release.mjs", import.meta.url)),
			"--out", join(scratch, "artifacts"), "--skip-check", "--skip-test", "--skip-install",
		], { cwd: workspace, encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Command failed: npm run hydrate:model-data/);
		assert.doesNotMatch(result.stderr, /generate:models/);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
