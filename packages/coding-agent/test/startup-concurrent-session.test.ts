import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { SessionLease } from "../src/core/session-lease.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const stderrByChild = new Map<ChildProcess, string>();

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	await new Promise<void>((resolvePromise) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			resolvePromise();
		}, 1_000);
		child.once("close", () => {
			clearTimeout(timeout);
			resolvePromise();
		});
	});
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		await stopChild(child);
		stderrByChild.delete(child);
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface CliDirs {
	agentDir: string;
	projectDir: string;
}

interface LeaseRecord {
	path: string;
	lease: SessionLease;
}

function setup(): CliDirs {
	const root = mkdtempSync(join(tmpdir(), "apex-concurrent-"));
	tempDirs.push(root);
	const dirs = { agentDir: join(root, "agent"), projectDir: join(root, "project") };
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	return dirs;
}

function findLeaseRecords(root: string): LeaseRecord[] {
	if (!existsSync(root)) {
		return [];
	}
	const records: LeaseRecord[] = [];
	const visit = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile() && entry.name.endsWith(".json") && basename(dir) === "leases") {
				try {
					records.push({ path, lease: JSON.parse(readFileSync(path, "utf8")) as SessionLease });
				} catch {}
			}
		}
	};
	visit(root);
	return records;
}

async function waitForLeases(dirs: CliDirs, predicate: (records: LeaseRecord[]) => boolean): Promise<LeaseRecord[]> {
	const stateRoot = join(dirs.projectDir, ".apex-code");
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const records = findLeaseRecords(stateRoot);
		if (predicate(records)) {
			return records;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`Timed out waiting for session leases under ${stateRoot}`);
}

function startCli(args: string[], dirs: CliDirs): ChildProcess {
	const child = spawn(process.execPath, [cliPath, ...args], {
		cwd: dirs.projectDir,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: dirs.agentDir,
			APEX_CODE_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["pipe", "ignore", "pipe"],
	});
	children.push(child);
	stderrByChild.set(child, "");
	child.stderr?.on("data", (chunk) => {
		stderrByChild.set(child, `${stderrByChild.get(child) ?? ""}${chunk.toString()}`);
	});
	return child;
}

async function waitForExit(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timed out. Stderr: ${stderrByChild.get(child) ?? ""}`));
		}, 25_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timeout);
			resolvePromise(exitCode);
		});
	});
	return { code, stderr: stderrByChild.get(child) ?? "" };
}

function startPersistentCli(dirs: CliDirs, extraArgs: string[] = []): ChildProcess {
	return startCli(["--mode", "rpc", "--permission-mode", "dontAsk", ...extraArgs], dirs);
}

const REFUSAL = "Another Apex Code session is already running here";

describe.skipIf(process.platform === "win32")("concurrent session startup gate", () => {
	it("refuses to start while another real session holds the working directory", async () => {
		const dirs = setup();
		const first = startPersistentCli(dirs);
		const [firstLease] = await waitForLeases(dirs, (records) => records.length === 1);
		expect(first.exitCode).toBeNull();

		const second = startCli(["-p", "hi", "--permission-mode", "dontAsk"], dirs);
		const result = await waitForExit(second);

		expect(result.stderr).toContain(REFUSAL);
		expect(result.stderr).toContain(`pid ${firstLease.lease.pid}`);
		expect(result.code).toBe(1);
	}, 30_000);

	it("starts a second real session when the operator passes --allow-concurrent", async () => {
		const dirs = setup();
		const first = startPersistentCli(dirs);
		await waitForLeases(dirs, (records) => records.length === 1);

		const second = startPersistentCli(dirs, ["--allow-concurrent"]);
		await waitForLeases(dirs, (records) => records.length === 2);

		expect(first.exitCode).toBeNull();
		expect(second.exitCode).toBeNull();
		expect(stderrByChild.get(second)).not.toContain(REFUSAL);
	}, 30_000);

	it("starts normally and reclaims the lease once the other real session is gone", async () => {
		const dirs = setup();
		const first = startPersistentCli(dirs);
		const [firstLease] = await waitForLeases(dirs, (records) => records.length === 1);
		await stopChild(first);

		const second = startPersistentCli(dirs);
		const [secondLease] = await waitForLeases(
			dirs,
			(records) => records.length === 1 && records[0]?.lease.pid !== firstLease.lease.pid,
		);

		expect(second.exitCode).toBeNull();
		expect(stderrByChild.get(second)).not.toContain(REFUSAL);
		expect(secondLease.lease.pid).not.toBe(firstLease.lease.pid);
		expect(existsSync(firstLease.path)).toBe(false);
	}, 30_000);
});
