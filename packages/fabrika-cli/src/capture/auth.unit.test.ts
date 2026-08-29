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
	readSessionProof,
	SECURE_COOKIE_PREFIX,
	SESSION_COOKIE_BASENAME,
	sessionCookies,
	signSessionToken,
} from "./auth.ts";

const SECRET = "a-preview-better-auth-secret";
const TOKEN = "t".repeat(32);
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
	it("names both unset halves rather than reading as a complete anonymous default", () => {
		expect(readIdentity({})).toEqual({
			_tag: "Missing",
			names: ["PREVIEW_TEST_SESSION_TOKEN", "BETTER_AUTH_SECRET"],
		});
	});

	it("names the one missing half", () => {
		expect(readIdentity({PREVIEW_TEST_SESSION_TOKEN: TOKEN})).toEqual({
			_tag: "Missing",
			names: ["BETTER_AUTH_SECRET"],
		});
		expect(readIdentity({BETTER_AUTH_SECRET: SECRET})).toEqual({
			_tag: "Missing",
			names: ["PREVIEW_TEST_SESSION_TOKEN"],
		});
	});

	it("reads a complete pair", () => {
		expect(readIdentity({PREVIEW_TEST_SESSION_TOKEN: TOKEN, BETTER_AUTH_SECRET: SECRET})).toEqual({
			_tag: "Identity",
			token: TOKEN,
			secret: SECRET,
		});
	});
});

/**
 * The probe's answers are better-auth's own, read at the `1.6.23` pin: `/get-session` returns a bare
 * JSON `null` when the signed cookie does not resolve to a session, and `{session, user}` when it
 * does. A body that is neither is UNKNOWN and must not read as anonymous — that collapse is the
 * whole defect this proof exists to close.
 */
describe("readSessionProof", () => {
	it("reads better-auth's null answer as anonymous", () => {
		expect(readSessionProof(200, "null")).toEqual({_tag: "Anonymous"});
	});

	it("reads a session payload as signed in, naming the user", () => {
		expect(readSessionProof(200, JSON.stringify({session: {id: "s1"}, user: {id: "u1"}}))).toEqual({
			_tag: "SignedIn",
			userId: "u1",
		});
	});

	it("reads a non-200 as unreadable, never as anonymous", () => {
		expect(readSessionProof(404, "null")._tag).toBe("Unreadable");
		expect(readSessionProof(500, "")._tag).toBe("Unreadable");
	});

	it("reads an unparseable or user-less body as unreadable", () => {
		expect(readSessionProof(200, "<!doctype html>")._tag).toBe("Unreadable");
		expect(readSessionProof(200, JSON.stringify({user: {}}))._tag).toBe("Unreadable");
	});

	it("reads an explicitly null user as anonymous", () => {
		expect(readSessionProof(200, JSON.stringify({session: null, user: null}))).toEqual({
			_tag: "Anonymous",
		});
	});
});
