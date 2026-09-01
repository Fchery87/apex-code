import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636), the S256 method only. Every MCP authorization server is required
 * to support it, and a verifier that never travels with the code is the only thing
 * standing between a callback URL and a token, so there is no plain fallback here.
 */

export interface PkcePair {
	verifier: string;
	challenge: string;
}

/** 48 bytes → 64 base64url characters, inside RFC 7636's 43-128 range. */
const VERIFIER_BYTES = 48;

export function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
	const verifier = random(VERIFIER_BYTES).toString("base64url");
	return { verifier, challenge: pkceChallenge(verifier) };
}
