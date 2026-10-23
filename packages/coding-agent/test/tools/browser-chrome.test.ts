import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChromeBrowser } from "../../src/core/tools/browser-chrome.ts";

const standIn = `const fs = require("node:fs");
const args = process.argv.slice(2);
const portArg = args.find((arg) => arg.startsWith("--remote-debugging-port="));
const port = Number(portArg.split("=")[1]);
const profile = args[args.indexOf("--user-data-dir") + 1];
fs.writeFileSync(process.env.APEX_BROWSER_REPORT, JSON.stringify({ args, profile, pid: process.pid }));
require("node:http").createServer((req, res) => {
  res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser" }));
}).listen(port);
setInterval(() => {}, 1000);
`;

describe("throwaway Chrome process", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("passes a temporary profile and a DevTools port, then kills the process and removes the profile", async () => {
		const root = mkdtempSync(join(tmpdir(), "apex-browser-chrome-"));
		roots.push(root);
		const binary = join(root, "chrome.js");
		const report = join(root, "report.json");
		writeFileSync(binary, standIn);

		const browser = createChromeBrowser({
			binary: process.execPath,
			binaryArgs: [binary],
			env: { APEX_BROWSER_REPORT: report },
			ready: async () => {
				for (let attempt = 0; attempt < 50 && !existsSync(report); attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			},
			connect: async () => ({ title: "stand-in", finalUrl: "http://127.0.0.1:3000/", console: [] }),
		});
		const page = await browser.open("http://127.0.0.1:3000/");

		const recorded = JSON.parse(require("node:fs").readFileSync(report, "utf8")) as {
			args: string[];
			profile: string;
			pid: number;
		};
		expect(page.title).toBe("stand-in");
		expect(recorded.args).toContain("--headless=new");
		expect(recorded.profile.startsWith(tmpdir())).toBe(true);
		expect(recorded.args.some((arg) => arg.startsWith("--remote-debugging-port="))).toBe(true);
		expect(existsSync(recorded.profile)).toBe(false);
		expect(() => process.kill(recorded.pid, 0)).toThrow();
	});

	it("returns a page naming the missing binary instead of throwing", async () => {
		const browser = createChromeBrowser({ binary: "/no/such/chrome" });
		const page = await browser.open("http://127.0.0.1:9/");
		expect(page.title).toContain("/no/such/chrome");
		expect(page.title).toContain("ENOENT");
		expect(page.screenshot).toBeUndefined();
	});
});
