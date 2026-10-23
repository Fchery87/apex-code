import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserOperations, BrowserPage } from "./browser.ts";

export interface ChromeBrowserOptions {
	/** Executable to spawn. Defaults to `chrome` on PATH. */
	binary?: string;
	/** Arguments placed before the Chrome flags. Tests use this to run a script under node. */
	binaryArgs?: string[];
	/** Extra environment for the child. */
	env?: NodeJS.ProcessEnv;
	/** Talks to the DevTools port. Tests inject this so they never open a socket. */
	connect?: (port: number, url: string) => Promise<BrowserPage>;
	/** Resolves when the child is ready to accept a connection. Tests wait on their report file. */
	ready?: () => Promise<void>;
}

const CHROME_FLAGS = ["--headless=new", "--disable-gpu", "--no-first-run"];

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

export function createChromeBrowser(options: ChromeBrowserOptions = {}): BrowserOperations {
	const binary = options.binary ?? "chrome";
	const connect = options.connect ?? (async () => ({ title: "", finalUrl: "", console: [] }));
	return {
		async open(url) {
			const profile = await mkdtemp(join(tmpdir(), "apex-browser-"));
			const port = await freePort();
			const args = [
				...(options.binaryArgs ?? []),
				...CHROME_FLAGS,
				`--remote-debugging-port=${port}`,
				"--user-data-dir",
				profile,
			];
			const child = spawn(binary, args, { env: { ...process.env, ...options.env }, stdio: "ignore" });
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			try {
				await options.ready?.();
				return await connect(port, url);
			} finally {
				child.kill();
				await exited;
				await rm(profile, { force: true, recursive: true });
			}
		},
	};
}
