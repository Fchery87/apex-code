import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishSessionShare, redactSecrets } from "../src/core/session-share.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const anthropicKey = `sk-ant-api03-${"A".repeat(40)}`;
const githubToken = `ghp_${"b".repeat(36)}`;
const awsKey = `AKIA${"C".repeat(16)}`;
const slackToken = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
const pemBlock = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

describe("session share redaction (HR.7)", () => {
	it("replaces each credential shape and counts the replacements", () => {
		const input = [anthropicKey, githubToken, awsKey, slackToken, pemBlock].join(" and ");
		const { text, count } = redactSecrets(input);
		expect(text).not.toContain(anthropicKey);
		expect(text).not.toContain(githubToken);
		expect(text).not.toContain(awsKey);
		expect(text).not.toContain(slackToken);
		expect(text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
		expect(text).toContain("[REDACTED]");
		expect(count).toBe(5);
	});

	it("leaves ordinary text and short look-alikes alone", () => {
		const input = "The sk- prefix alone, ghp_short, and version 1.2.3 are fine.";
		expect(redactSecrets(input)).toEqual({ text: input, count: 0 });
	});

	it("uploads the redacted export, never the raw one, and reports the count to the confirmation", async () => {
		const root = await mkdtemp(join(tmpdir(), "apex-share-redact-"));
		roots.push(root);
		const seen: { count?: number; uploaded?: string } = {};
		const result = await publishSessionShare({
			temporaryRoot: root,
			confirm: async (redactions) => {
				seen.count = redactions;
				return true;
			},
			exportToHtml: async (path) => {
				await writeFile(path, `token ${anthropicKey} end`);
			},
			publishGist: async (path) => {
				seen.uploaded = await readFile(path, "utf8");
				return "https://gist.github.com/user/abc";
			},
		});
		expect(result.kind).toBe("published");
		expect(seen.count).toBe(1);
		expect(seen.uploaded).not.toContain(anthropicKey);
		expect(seen.uploaded).toContain("[REDACTED]");
	});

	it("cancelling after redaction uploads nothing and leaves no export behind", async () => {
		const root = await mkdtemp(join(tmpdir(), "apex-share-cancel-"));
		roots.push(root);
		let uploaded = false;
		const result = await publishSessionShare({
			temporaryRoot: root,
			confirm: async () => false,
			exportToHtml: async (path) => {
				await writeFile(path, `token ${githubToken}`);
			},
			publishGist: async () => {
				uploaded = true;
				return "https://gist.github.com/user/x";
			},
		});
		expect(result.kind).toBe("cancelled");
		expect(uploaded).toBe(false);
		expect(await readdir(root)).toEqual([]);
	});
});
