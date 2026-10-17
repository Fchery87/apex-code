import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const rootManifestText = readFileSync(join(root, "package.json"), "utf8");

describe("repository root (HR.28)", () => {
	it("the root package is named for this project, not for Pi", () => {
		expect((JSON.parse(rootManifestText) as { name: string }).name).toBe("apex-code-monorepo");
	});

	it("the root manifest is formatted the way the rest of the repository is", () => {
		const parsed = JSON.parse(rootManifestText);
		expect(rootManifestText).toBe(`${JSON.stringify(parsed, null, "\t")}\n`);
	});

	it("the Pi-era leftovers and the stray config are gone", () => {
		for (const path of ["reasonix.toml", "mini-test.sh", "pi-test.sh", "pi-test.ps1", "pi-test.bat"]) {
			expect(existsSync(join(root, path)), path).toBe(false);
		}
	});

	it("the dev launcher is kept under its project name", () => {
		expect(existsSync(join(root, "apex-test.sh"))).toBe(true);
	});
});
