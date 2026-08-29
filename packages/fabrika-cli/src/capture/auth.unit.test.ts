/**
 * The session cookie must satisfy better-auth's READER, not merely round-trip through this module.
 * So the assertions below are better-call's own acceptance rules (`dist/context.mjs`
 * `getSignedCookie`: split at the last `.`, signature exactly 44 chars ending in `=`, HMAC verified
 * against the secret) and the verification runs through WebCrypto — a different implementation than
 * the `node:crypto` one that signed it, so a self-consistent-but-wrong signature cannot pass.
 */
import {webcrypto} from "node:crypto";
import {describe, expect, it} from "vitest";
import {
	readIdentity,
	SECURE_COOKIE_PREFIX,
	SESSION_COOKIE_BASENAME,
	sessionCookies,
	signSessionToken,
} from "./auth.ts";

const SECRET = "a-preview-better-auth-secret";
const TOKEN = "sO7mQ2wV5xR9tY1uI3oP6aS8dF0gH4jK";
const PREVIEW = "https://phoenix-pr-42.kampusinfra.workers.dev";

const verify = async (signed: string): Promise<boolean> => {
	const decoded = decodeURIComponent(signed);
	const cut = decoded.lastIndexOf(".");
	const value = decoded.slice(0, cut);
	const signature = decoded.slice(cut + 1);
	const bytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
	const key = await webcrypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SECRET),
		{name: "HMAC", hash: "SHA-256"},
		false,
		["verify"],
	);
	return webcrypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(value));
};

describe("signSessionToken", () => {
	it("produces a value better-call's getSignedCookie accepts and verifies", async () => {
		const signed = signSessionToken(TOKEN, SECRET);
		const decoded = decodeURIComponent(signed);
		const cut = decoded.lastIndexOf(".");
		expect(decoded.slice(0, cut)).toBe(TOKEN);
		expect(decoded.slice(cut + 1)).toHaveLength(44);
		expect(decoded.slice(cut + 1).endsWith("=")).toBe(true);
		expect(await verify(signed)).toBe(true);
	});

	it("does not verify under a different secret", async () => {
		expect(await verify(signSessionToken(TOKEN, "some-other-secret"))).toBe(false);
	});
});

describe("sessionCookies", () => {
	it("seeds both the prefixed and unprefixed name on an https preview", () => {
		const cookies = sessionCookies(PREVIEW, TOKEN, SECRET);
		expect(cookies.map((c) => c.name)).toEqual([
			SESSION_COOKIE_BASENAME,
			`${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASENAME}`,
		]);
		expect(cookies.every((c) => c.secure === true)).toBe(true);
		expect(new Set(cookies.map((c) => c.value)).size).toBe(1);
	});

	it("omits the __Secure- name on http, where the browser would reject it", () => {
		const cookies = sessionCookies("http://localhost:3000", TOKEN, SECRET);
		expect(cookies.map((c) => c.name)).toEqual([SESSION_COOKIE_BASENAME]);
		expect(cookies[0]?.secure).toBe(false);
	});
});

describe("readIdentity", () => {
	it("reads no identity as the anonymous default", () => {
		expect(readIdentity({})).toBeNull();
	});

	it("names the missing half rather than falling back to anonymous", () => {
		expect(readIdentity({PREVIEW_TEST_SESSION_TOKEN: TOKEN})).toEqual({
			missing: "BETTER_AUTH_SECRET",
		});
		expect(readIdentity({BETTER_AUTH_SECRET: SECRET})).toEqual({
			missing: "PREVIEW_TEST_SESSION_TOKEN",
		});
	});

	it("reads a complete pair", () => {
		expect(readIdentity({PREVIEW_TEST_SESSION_TOKEN: TOKEN, BETTER_AUTH_SECRET: SECRET})).toEqual({
			token: TOKEN,
			secret: SECRET,
		});
	});
});
