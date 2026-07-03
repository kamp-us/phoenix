/**
 * The pure OAuth surface (#1761), off-network (ADR 0082): PKCE verifier/challenge, CSRF state,
 * the authorize-URL builder, the refresh DECISION, and the token-response mapper. No real CF,
 * no browser, no callback server — only the total transforms the browser flow is built on.
 */
import {createHash} from "node:crypto";
import {assert, describe, it} from "@effect/vitest";
import {
	authorize,
	FLAGSHIP_OAUTH_SCOPES,
	generatePkce,
	generateState,
	OAUTH_CLIENT_ID,
	OAUTH_REDIRECT_URI,
	OFFLINE_ACCESS_SCOPE,
	REFRESH_WINDOW_MS,
	shouldRefresh,
	tokensFromResponse,
} from "./oauth.ts";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("generateState", () => {
	it("is URL-safe base64url and high-entropy (distinct per call)", () => {
		const a = generateState();
		const b = generateState();
		assert.match(a, BASE64URL);
		assert.notStrictEqual(a, b);
		assert.isAtLeast(a.length, 20);
	});
});

describe("generatePkce", () => {
	it("derives the S256 challenge as base64url(sha256(verifier)) (RFC 7636)", () => {
		const {verifier, challenge} = generatePkce();
		assert.match(verifier, BASE64URL);
		assert.match(challenge, BASE64URL);
		const expected = createHash("sha256").update(verifier).digest("base64url");
		assert.strictEqual(challenge, expected);
	});

	it("mints a fresh verifier each call", () => {
		assert.notStrictEqual(generatePkce().verifier, generatePkce().verifier);
	});
});

describe("authorize", () => {
	it("builds a PKCE authorize URL with client id, redirect, S256 challenge, state, and scopes", () => {
		const auth = authorize(FLAGSHIP_OAUTH_SCOPES);
		const url = new URL(auth.url);
		assert.strictEqual(url.searchParams.get("client_id"), OAUTH_CLIENT_ID);
		assert.strictEqual(url.searchParams.get("redirect_uri"), OAUTH_REDIRECT_URI);
		assert.strictEqual(url.searchParams.get("response_type"), "code");
		assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
		assert.strictEqual(url.searchParams.get("state"), auth.state);
		// the challenge on the wire is derived from the (secret) verifier we keep locally
		const derived = createHash("sha256").update(auth.verifier).digest("base64url");
		assert.strictEqual(url.searchParams.get("code_challenge"), derived);
	});

	it("appends offline_access so the grant returns a refresh token", () => {
		const auth = authorize(FLAGSHIP_OAUTH_SCOPES);
		const scope = new URL(auth.url).searchParams.get("scope") ?? "";
		const scopes = scope.split(" ");
		for (const s of FLAGSHIP_OAUTH_SCOPES) {
			assert.include(scopes, s);
		}
		assert.include(scopes, OFFLINE_ACCESS_SCOPE);
	});

	it("requests the configured Flagship scopes (the single-point-of-change constant)", () => {
		// AC#3: the requested scope is a documented constant, not a magic string. This pins the
		// wired value so a change is a deliberate, reviewed edit (grantability pending founder
		// dashboard confirmation — see the file docblock's SCOPE CAVEAT).
		assert.deepStrictEqual(
			[...FLAGSHIP_OAUTH_SCOPES],
			["flagship:read", "flagship:write", "account:read", "user:read"],
		);
	});
});

describe("shouldRefresh", () => {
	const now = 1_000_000_000_000;

	it("refreshes when already expired", () => {
		assert.isTrue(shouldRefresh(now - 1, now));
	});

	it("refreshes when inside the pre-expiry window", () => {
		assert.isTrue(shouldRefresh(now + REFRESH_WINDOW_MS - 1, now));
	});

	it("does not refresh when comfortably before the window", () => {
		assert.isFalse(shouldRefresh(now + REFRESH_WINDOW_MS + 60_000, now));
	});

	it("never refreshes an unknown (undefined) expiry", () => {
		assert.isFalse(shouldRefresh(undefined, now));
	});
});

describe("tokensFromResponse", () => {
	it("stamps absolute expiry from expires_in and splits scopes", () => {
		const now = 1_700_000_000_000;
		const tokens = tokensFromResponse(
			{
				access_token: "acc",
				refresh_token: "ref",
				expires_in: 3600,
				scope: "flagship:read flagship:write offline_access",
			},
			now,
		);
		assert.strictEqual(tokens.accessToken, "acc");
		assert.strictEqual(tokens.refreshToken, "ref");
		assert.strictEqual(tokens.expiresAt, now + 3600 * 1000);
		assert.deepStrictEqual(
			[...tokens.scopes],
			["flagship:read", "flagship:write", "offline_access"],
		);
	});

	it("yields an empty scope list when the response omits scopes", () => {
		const tokens = tokensFromResponse(
			{access_token: "a", refresh_token: "r", expires_in: 10, scope: ""},
			0,
		);
		assert.deepStrictEqual([...tokens.scopes], []);
	});
});
