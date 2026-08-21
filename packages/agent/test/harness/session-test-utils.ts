import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (!existsSync(dir)) continue;
		let retries = 5;
		while (retries > 0) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch (err: any) {
				if (err.code === "EBUSY" || err.code === "ENOTEMPTY" || err.code === "EPERM") {
					retries--;
					if (retries === 0) throw err;
					await new Promise((resolve) => setTimeout(resolve, 100));
				} else {
					throw err;
				}
			}
		}
	}
});
