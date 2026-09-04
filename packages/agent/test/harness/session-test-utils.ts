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
		// Windows keeps directory handles alive briefly after a killed child
		// process is reaped, and CI file scanners delay releases further, so a
		// freshly used directory may not be deletable for a few hundred
		// milliseconds. Retry well past that window before failing loudly.
		let retries = 12;
		while (retries > 0) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch (err: any) {
				if (err.code === "EBUSY" || err.code === "ENOTEMPTY" || err.code === "EPERM") {
					retries--;
					if (retries === 0) throw err;
					await new Promise((resolve) => setTimeout(resolve, 250));
				} else {
					throw err;
				}
			}
		}
	}
});
