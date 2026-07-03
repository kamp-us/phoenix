/**
 * The OAuth pure core (#1761) off-network (ADR 0082): the PKCE challenge (RFC 7636 test
 * vector), the authorize-URL build, callback validation (success / CSRF mismatch / provider
 * error / missing code), the token-request forms, the token-response decode + expiry
 * computation, and the refresh-window decision. The effectful shell (loopback server, browser
 * open, token HTTP exchange) is not unit-tested — it is a thin platform wrapper.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	buildAuthorizeUrl,
	CF_OAUTH_AUTHORIZE_URL,
	decodeTokenResponse,
	needsRefresh,
	OAUTH_REDIRECT_URI,
	OAUTH_REFRESH_WINDOW_MS,
	parseCallbackQuery,
	pkceChallengeS256,
	refreshTokenForm,
	tokenExchangeForm,
} from "./oauth.ts";

describe("pkceChallengeS256", () => {
	it("matches the RFC 7636 Appendix B test vector", () => {
		// verifier → challenge from https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
		assert.strictEqual(
			pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});
});

describe("buildAuthorizeUrl", () => {
	it("carries response_type, client_id, redirect_uri, scope, state, and the S256 challenge", () => {
		const url = new URL(
			buildAuthorizeUrl({
				clientId: "client-123",
				redirectUri: OAUTH_REDIRECT_URI,
				scopes: ["feature_flags:read", "feature_flags:write", "offline_access"],
				state: "state-xyz",
				codeChallenge: "challenge-abc",
			}),
		);
		assert.strictEqual(`${url.origin}${url.pathname}`, CF_OAUTH_AUTHORIZE_URL);
		assert.strictEqual(url.searchParams.get("response_type"), "code");
		assert.strictEqual(url.searchParams.get("client_id"), "client-123");
		assert.strictEqual(url.searchParams.get("redirect_uri"), OAUTH_REDIRECT_URI);
		assert.strictEqual(
			url.searchParams.get("scope"),
			"feature_flags:read feature_flags:write offline_access",
		);
		assert.strictEqual(url.searchParams.get("state"), "state-xyz");
		assert.strictEqual(url.searchParams.get("code_challenge"), "challenge-abc");
		assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
	});
});

describe("parseCallbackQuery", () => {
	it.effect("returns the code when state matches", () =>
		Effect.gen(function* () {
			const code = yield* parseCallbackQuery(
				new URLSearchParams({code: "auth-code", state: "s1"}),
				"s1",
			);
			assert.strictEqual(code, "auth-code");
		}),
	);

	it.effect("fails on a state mismatch (CSRF)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				parseCallbackQuery(new URLSearchParams({code: "c", state: "attacker"}), "s1"),
			);
			assert.isTrue(exit._tag === "Failure");
			assert.include(exit._tag === "Failure" ? String(exit.cause) : "", "CSRF");
		}),
	);

	it.effect("surfaces a provider error param with its description", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				parseCallbackQuery(
					new URLSearchParams({error: "access_denied", error_description: "user said no"}),
					"s1",
				),
			);
			assert.isTrue(exit._tag === "Failure");
			const message = exit._tag === "Failure" ? String(exit.cause) : "";
			assert.include(message, "access_denied");
			assert.include(message, "user said no");
		}),
	);

	it.effect("fails when the callback carried no code", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(parseCallbackQuery(new URLSearchParams({state: "s1"}), "s1"));
			assert.isTrue(exit._tag === "Failure");
		}),
	);
});

describe("token request forms", () => {
	it("tokenExchangeForm is a PKCE authorization_code grant", () => {
		assert.deepStrictEqual(
			tokenExchangeForm({
				clientId: "c",
				code: "the-code",
				redirectUri: OAUTH_REDIRECT_URI,
				codeVerifier: "the-verifier",
			}),
			{
				grant_type: "authorization_code",
				client_id: "c",
				code: "the-code",
				redirect_uri: OAUTH_REDIRECT_URI,
				code_verifier: "the-verifier",
			},
		);
	});

	it("refreshTokenForm is a refresh_token grant", () => {
		assert.deepStrictEqual(refreshTokenForm({clientId: "c", refreshToken: "r"}), {
			grant_type: "refresh_token",
			client_id: "c",
			refresh_token: "r",
		});
	});
});

describe("decodeTokenResponse", () => {
	it.effect("computes an absolute expiresAt from the relative expires_in", () =>
		Effect.gen(function* () {
			const now = 1_000_000;
			const config = yield* decodeTokenResponse(
				{access_token: "at", refresh_token: "rt", expires_in: 3600},
				now,
			);
			assert.strictEqual(config.accessToken, "at");
			assert.strictEqual(config.refreshToken, "rt");
			assert.strictEqual(config.expiresAt, now + 3600 * 1000);
		}),
	);

	it.effect("tolerates a response with no expires_in / refresh_token", () =>
		Effect.gen(function* () {
			const config = yield* decodeTokenResponse({access_token: "at"}, 0);
			assert.strictEqual(config.accessToken, "at");
			assert.strictEqual(config.refreshToken, undefined);
			assert.strictEqual(config.expiresAt, undefined);
		}),
	);

	it.effect("fails on a response missing the access_token", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(decodeTokenResponse({token_type: "bearer"}, 0));
			assert.isTrue(exit._tag === "Failure");
		}),
	);
});

describe("needsRefresh", () => {
	it("is false when there is no expiry (a non-expiring token)", () => {
		assert.isFalse(needsRefresh(undefined, Date.now()));
	});

	it("is false well before the refresh window", () => {
		const now = 1_000_000;
		assert.isFalse(needsRefresh(now + OAUTH_REFRESH_WINDOW_MS + 60_000, now));
	});

	it("is true once inside the refresh window", () => {
		const now = 1_000_000;
		assert.isTrue(needsRefresh(now + OAUTH_REFRESH_WINDOW_MS - 1, now));
	});

	it("is true once expired", () => {
		const now = 1_000_000;
		assert.isTrue(needsRefresh(now - 1, now));
	});
});
