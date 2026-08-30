/**
 * Windows self-update detection diagnostic.
 *
 * Replicates test/config.test.ts's createPnpmGlobalInstall() fixture and
 * prints every gate that getSelfUpdateCommand() consults, so the win32
 * failure can be root-caused from CI logs.
 *
 * Run: npx tsx scripts/win32-selfupdate-diagnose.mjs
 */

import { spawnSync as nodeSpawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import crossSpawn from "cross-spawn";

function log(label, value) {
	console.log(`[diag] ${label}: ${JSON.stringify(value)}`);
}

log("platform", process.platform);
log("node", process.version);
log("PATHEXT", process.env.PATHEXT);

// ── Fixture: mirrors createPnpmGlobalInstall() ──
const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
const binDir = join(temp, "bin");
const root = join(temp, "pnpm", "global", "5", "node_modules");
const packageDir = join(root, "@mariozechner", "pi-coding-agent");
mkdirSync(packageDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
const shim = join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
writeFileSync(
	shim,
	process.platform === "win32"
		? `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`
		: `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${root.replaceAll("'", "'\\''")}'\n\texit 0\nfi\nexit 1\n`,
);
chmodSync(shim, 0o755);
process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
process.env.PI_PACKAGE_DIR = packageDir;
Object.defineProperty(process, "execPath", {
	value: join(packageDir, "dist", "cli.js"),
	configurable: true,
});

log("temp", temp);
log("binDir", binDir);
log("root", root);
log("packageDir (PI_PACKAGE_DIR)", process.env.PI_PACKAGE_DIR);
log("execPath (overridden)", process.execPath);
log("PATH starts with binDir", process.env.PATH.startsWith(binDir));

// ── Raw spawn probes ──
const opts = { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] };
const viaCrossSpawn = crossSpawn.sync("pnpm", ["root", "-g"], opts);
log(
	"crossSpawn.sync(pnpm root -g)",
	{ status: viaCrossSpawn.status, stdout: viaCrossSpawn.stdout, stderr: viaCrossSpawn.stderr, error: String(viaCrossSpawn.error ?? "") },
);
const viaNode = nodeSpawnSync("pnpm", ["root", "-g"], opts);
log(
	"nodeSpawnSync(pnpm root -g)",
	{ status: viaNode.status, stdout: viaNode.stdout, stderr: viaNode.stderr, error: String(viaNode.error ?? "") },
);
const viaNodeShell = nodeSpawnSync("pnpm", ["root", "-g"], { ...opts, shell: true });
log(
	"nodeSpawnSync shell:true",
	{ status: viaNodeShell.status, stdout: viaNodeShell.stdout, stderr: viaNodeShell.stderr, error: String(viaNodeShell.error ?? "") },
);
const wherePnpm = nodeSpawnSync("where", ["pnpm"], { encoding: "utf-8" });
log("where pnpm", { status: wherePnpm.status, stdout: wherePnpm.stdout });

// ── The real functions under test ──
const config = await import("../packages/coding-agent/src/config.ts");
log("detectInstallMethod()", config.detectInstallMethod());
log("getSelfUpdateCommand('apex-code')", config.getSelfUpdateCommand("apex-code"));
log(
	"getSelfUpdateCommandForMethod('pnpm') equivalent",
	config.getSelfUpdateCommand("apex-code", ["pnpm"]),
);
