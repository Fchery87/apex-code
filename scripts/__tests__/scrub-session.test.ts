import { describe, expect, it } from "vitest";
import { findSecrets, scrub } from "../scrub-session.ts";

describe("scrub", () => {
	it("redacts api-key-shaped strings", () => {
		const line = JSON.stringify({ apiKey: "tcb_ds_v1.AbC123_xyz-QQ" });
		expect(scrub(line)).not.toContain("AbC123");
		expect(scrub(line)).toContain("[REDACTED]");
	});
});

it("replaces absolute home paths with a placeholder", () => {
	expect(scrub("/home/alice/Projects/x")).toBe("$HOME/Projects/x");
	expect(scrub("/Users/alice/Projects/x")).toBe("$HOME/Projects/x");
	expect(scrub(JSON.stringify({ cwd: "/home/alice/Projects/x" }))).toContain("$HOME/Projects/x");
});

it("preserves message structure and tree identity", () => {
	const line = JSON.stringify({ type: "message", id: "a1", parentId: null, cwd: "/home/alice/project" });
	const result: unknown = JSON.parse(scrub(line));
	expect(result).toMatchObject({ type: "message", id: "a1", parentId: null, cwd: "$HOME/project" });
});

describe("findSecrets", () => {
	it("detects a provider credential and accepts benign text", () => {
		expect(findSecrets('{"key":"sk-live_0123456789abcdef"}')).toHaveLength(1);
		expect(findSecrets('{"text":"hello"}')).toHaveLength(0);
	});
});

it("scrubs provider keys, high-entropy tokens, hostnames, and email addresses", () => {
	const input = [
		"sk-proj-abcdefghijklmnopqrstuvwxyz123456",
		"ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		"AKIAIOSFODNN7EXAMPLE",
		"ZXhhbXBsZV9oaWdoX2VudHJvcHlfdG9rZW5fMDEyMzQ1Njc4OWFiY2RlZg==",
		"build.internal.example.com",
		"owner@example.com",
	].join(" ");
	const result = scrub(input);
	for (const sensitive of input.split(" ")) expect(result).not.toContain(sensitive);
	expect(result.match(/\[REDACTED\]/g)).toHaveLength(6);
});

it("finds every sensitive class before scrubbing and none afterward", () => {
	const input = [
		"/home/alice/project",
		"sk-proj-abcdefghijklmnopqrstuvwxyz123456",
		"ZXhhbXBsZV9oaWdoX2VudHJvcHlfdG9rZW5fMDEyMzQ1Njc4OWFiY2RlZg==",
		"build.internal.example.com",
		"owner@example.com",
	].join(" ");
	expect(findSecrets(input).map(({ kind }) => kind)).toEqual([
		"home-path",
		"provider-key",
		"high-entropy-token",
		"hostname",
		"email",
	]);
	expect(findSecrets(scrub(input))).toHaveLength(0);
});

it("normalizes Windows user homes, including JSON-escaped paths", () => {
	expect(scrub(String.raw`C:\Users\alice\project`)).toBe(String.raw`$HOME\project`);
	expect(scrub(JSON.stringify({ cwd: String.raw`C:\Users\alice\project` }))).toContain(String.raw`$HOME\\project`);
});

it("is idempotent and does not redact session tree identifiers", () => {
	const input = JSON.stringify({
		type: "message",
		id: "123e4567-e89b-12d3-a456-426614174000",
		parentId: "abcdef0123456789abcdef0123456789",
		text: "owner@example.com /home/alice/project",
	});
	const once = scrub(input);
	expect(scrub(once)).toBe(once);
	expect(JSON.parse(once)).toMatchObject({
		id: "123e4567-e89b-12d3-a456-426614174000",
		parentId: "abcdef0123456789abcdef0123456789",
	});
	expect(findSecrets(once)).toHaveLength(0);
});

it("preserves JSONL line and tree-edge order", () => {
	const input = [
		JSON.stringify({ type: "message", id: "a1", parentId: null, cwd: "/home/alice/project" }),
		JSON.stringify({ type: "message", id: "a2", parentId: "a1", host: "build.internal.example.com" }),
		"",
	].join("\n");
	const result = scrub(input);
	expect(result.split("\n")).toHaveLength(input.split("\n").length);
	expect(
		result
			.trimEnd()
			.split("\n")
			.map((line) => {
				const { id, parentId } = JSON.parse(line);
				return [id, parentId];
			}),
	).toEqual([
		["a1", null],
		["a2", "a1"],
	]);
});

it("redacts credentials in authorization headers and common provider formats", () => {
	const values = [
		"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMDEyMzQ1Njc4OQ",
		"sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
		"AIzaSyAabcdefghijklmnopqrstuvwx123456",
	];
	const result = scrub(values.join("\n"));
	for (const value of values) expect(result).not.toContain(value);
	expect(findSecrets(result)).toHaveLength(0);
});

it("never scrubs or reports id and parentId values", () => {
	const id = "ZXhhbXBsZV9zZXNzaW9uX2lkXzAxMjM0NTY3ODlhYmNkZWY=";
	const parentId = "QW5vdGhlcl9oaWdoX2VudHJvcHlfcGFyZW50X2lkXzEyMzQ1Njc4OTA=";
	const input = JSON.stringify({ type: "message", id, parentId, text: "owner@example.com" });
	const result = scrub(input);
	expect(JSON.parse(result)).toMatchObject({ id, parentId });
	expect(findSecrets(input).map(({ kind }) => kind)).toEqual(["email"]);
});

it("reports source offsets without mistaking filenames or overlapping known keys", () => {
	const providerKey = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const input = `read scrub-session.ts, then use ${providerKey} at build.example.com`;
	const findings = findSecrets(input);
	expect(findings.map(({ kind }) => kind)).toEqual(["provider-key", "hostname"]);
	for (const finding of findings) {
		expect(input.slice(finding.index, finding.index + finding.length)).not.toBe("");
	}
});

it("keeps finding offsets aligned after protected tree identifiers", () => {
	const input = JSON.stringify({ id: "ZXhhbXBsZV9zZXNzaW9uX2lkXzAxMjM0NTY3ODlhYmNkZWY=", host: "build.example.com" });
	const [finding] = findSecrets(input);
	expect(input.slice(finding.index, finding.index + finding.length)).toBe("build.example.com");
});

it("detects hyphenated provider and delimiter-rich credentials", () => {
	const values = [
		"sk-abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
		"glpat-abcdefghijklmnopqrstuvwxyz1234567890",
		["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
	];
	for (const value of values) {
		expect(scrub(value)).toBe("[REDACTED]");
		expect(findSecrets(value)).toHaveLength(1);
	}
});

it("handles internal, multi-label, and IP hostnames", () => {
	const values = ["build.internal", "host.example.co.uk", "192.0.2.44"];
	for (const value of values) {
		expect(scrub(value)).toBe("[REDACTED]");
		expect(findSecrets(value)).toHaveLength(1);
	}
});

it("does not restore a tree identifier into colliding content", () => {
	const id = "1234567890123456789012345678901234567890";
	const input = JSON.stringify({ type: "message", id, parentId: null, text: " ".repeat(id.length) });
	const result = JSON.parse(scrub(input));
	expect(result.id).toBe(id);
	expect(result.text).toBe(" ".repeat(id.length));
});
