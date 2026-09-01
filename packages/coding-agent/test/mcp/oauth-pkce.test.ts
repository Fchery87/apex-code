import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkcePair, pkceChallenge } from "../../src/core/mcp/oauth/pkce.ts";

describe("createPkcePair", () => {
	it("derives the challenge as base64url(SHA256(verifier))", () => {
		const pair = createPkcePair(() => Buffer.alloc(48, 7));
		const expected = createHash("sha256").update(pair.verifier, "ascii").digest("base64url");
		expect(pair.challenge).toBe(expected);
	});

	it("matches the RFC 7636 appendix B vector", () => {
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		expect(pkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it("produces a 64-character base64url verifier from 48 seeded bytes", () => {
		const pair = createPkcePair(() => Buffer.alloc(48, 1));
		expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
	});

	it("produces a different pair on each call", () => {
		expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
	});
});
