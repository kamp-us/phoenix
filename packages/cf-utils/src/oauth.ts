/**
 * The browser OAuth login flow (#1761) — the `wrangler login` mold: Authorization-Code +
 * PKCE against Cloudflare's self-managed public OAuth clients (GA 2026-06-03). It exists so
 * a human never pastes an API token into the terminal (the #1730 token-paste flow leaks the
 * secret on a stream/VOD); OAuth authorizes in the browser, the secret never crosses the
 * terminal. The acquired access + refresh token persist through the SAME keychain seam as the
 * pasted token, and `credentials.ts` refreshes on expiry.
 *
 * The pure core — PKCE challenge, authorize-URL build, callback parse, token-request forms,
 * token-response decode, refresh-window decision — is unit-tested off-network (ADR 0082). The
 * effectful shell (the loopback callback server, the browser open, the token HTTP exchange)
 * is a thin platform wrapper, the same stance `keychain.ts` takes shelling to `security`: a
 * raw `node:http` loopback server + a `node:child_process` browser open are the pragmatic
 * primitives a one-shot CLI callback needs, not a full `HttpServer` layer.
 */

import {createHash, randomBytes} from "node:crypto";
import * as http from "node:http";
import type {OAuthConfig} from "@distilled.cloud/cloudflare/Credentials";
import {Config, Data, Effect} from "effect";
import * as Schema from "effect/Schema";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";

// Cloudflare's self-managed OAuth endpoints (the `wrangler login` flow): authorize in the
// dashboard, exchange/refresh at the token endpoint. See packages/cf-utils/README.md for the
// one-time public-client registration these depend on.
export const CF_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const CF_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

/** The loopback the browser is redirected back to (the OAuth `redirect_uri`). */
export const OAUTH_CALLBACK_PORT = 8976;
export const OAUTH_CALLBACK_PATH = "/oauth/callback";
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

/**
 * The scopes the registered public client must grant: the Flagship read/write permission
 * cf-utils' flag operations need (Cloudflare's self-managed OAuth scope names mirror the
 * API-token permission names — GA 2026-06-03), plus `offline_access` for the refresh token.
 * This is the single place the requested scopes live — align it with the granted scopes on
 * the client the founder registers (README § "One-time founder setup").
 */
export const OAUTH_SCOPES = [
	"feature_flags:read",
	"feature_flags:write",
	"offline_access",
] as const;

/** Refresh a little before the access token actually expires (matches the SDK's window). */
export const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * The public PKCE client id registered once in the Cloudflare dashboard (a public client, no
 * client secret). Read from `$CF_UTILS_OAUTH_CLIENT_ID` rather than hardcoded so the id isn't
 * baked into source and each operator points at their own registered client.
 */
export const oauthClientId = Config.string("CF_UTILS_OAUTH_CLIENT_ID");

/** The OAuth flow could not complete (callback error, state mismatch, or a bad token response). */
export class OAuthFlowError extends Data.TaggedError("OAuthFlowError")<{
	readonly reason: string;
}> {
	override get message(): string {
		return `OAuth login failed: ${this.reason}`;
	}
}

/** base64url without padding — the PKCE / RFC 7636 encoding. */
export const base64UrlEncode = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The S256 PKCE challenge for a verifier: base64url(SHA-256(verifier)). */
export const pkceChallengeS256 = (verifier: string): string =>
	base64UrlEncode(createHash("sha256").update(verifier).digest());

/** A high-entropy PKCE verifier (RFC 7636 §4.1: 43–128 base64url chars). */
export const randomVerifier = (): string => base64UrlEncode(randomBytes(32));

/** A CSRF `state` nonce echoed back on the callback and checked for equality. */
export const randomState = (): string => base64UrlEncode(randomBytes(16));

export interface AuthorizeUrlParams {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly scopes: ReadonlyArray<string>;
	readonly state: string;
	readonly codeChallenge: string;
}

/** Build the dashboard authorize URL for the Authorization-Code + PKCE flow. */
export const buildAuthorizeUrl = (params: AuthorizeUrlParams): string => {
	const url = new URL(CF_OAUTH_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("scope", params.scopes.join(" "));
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
};

/**
 * Validate the callback query and extract the authorization `code`. Fails when the provider
 * returned an `error`, when `state` doesn't match the one we sent (CSRF), or when `code` is
 * absent — each a reason the flow cannot continue.
 */
export const parseCallbackQuery = (
	search: URLSearchParams,
	expectedState: string,
): Effect.Effect<string, OAuthFlowError> => {
	const error = search.get("error");
	if (error !== null) {
		const description = search.get("error_description");
		return Effect.fail(
			new OAuthFlowError({reason: description !== null ? `${error} — ${description}` : error}),
		);
	}
	const state = search.get("state");
	if (state !== expectedState) {
		return Effect.fail(new OAuthFlowError({reason: "callback state did not match (CSRF check)"}));
	}
	const code = search.get("code");
	if (code === null || code.length === 0) {
		return Effect.fail(new OAuthFlowError({reason: "callback carried no authorization code"}));
	}
	return Effect.succeed(code);
};

/** The `application/x-www-form-urlencoded` body exchanging an auth code for tokens. */
export const tokenExchangeForm = (params: {
	readonly clientId: string;
	readonly code: string;
	readonly redirectUri: string;
	readonly codeVerifier: string;
}): Record<string, string> => ({
	grant_type: "authorization_code",
	client_id: params.clientId,
	code: params.code,
	redirect_uri: params.redirectUri,
	code_verifier: params.codeVerifier,
});

/** The form body refreshing an expired access token with the stored refresh token. */
export const refreshTokenForm = (params: {
	readonly clientId: string;
	readonly refreshToken: string;
}): Record<string, string> => ({
	grant_type: "refresh_token",
	client_id: params.clientId,
	refresh_token: params.refreshToken,
});

const TokenResponse = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.optional(Schema.String),
	expires_in: Schema.optional(Schema.Number),
});

/**
 * Decode a token-endpoint JSON response into an `OAuthConfig`, computing the absolute
 * `expiresAt` (epoch ms) from the relative `expires_in` so the resolver can decide staleness
 * without re-reading the clock the provider used.
 */
export const decodeTokenResponse = (
	json: unknown,
	now: number,
): Effect.Effect<OAuthConfig, OAuthFlowError> =>
	Schema.decodeUnknownEffect(TokenResponse)(json).pipe(
		Effect.map(
			(decoded): OAuthConfig => ({
				accessToken: decoded.access_token,
				...(decoded.refresh_token !== undefined ? {refreshToken: decoded.refresh_token} : {}),
				...(decoded.expires_in !== undefined ? {expiresAt: now + decoded.expires_in * 1000} : {}),
			}),
		),
		Effect.mapError(
			(cause) => new OAuthFlowError({reason: `unrecognized token response: ${String(cause)}`}),
		),
	);

/** Whether a stored access token is expired (or inside the refresh window) and must refresh. */
export const needsRefresh = (expiresAt: number | undefined, now: number): boolean =>
	expiresAt !== undefined && now >= expiresAt - OAUTH_REFRESH_WINDOW_MS;

const postTokenForm = (
	form: Record<string, string>,
): Effect.Effect<OAuthConfig, OAuthFlowError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient;
		const response = yield* client
			.post(CF_OAUTH_TOKEN_URL, {
				body: HttpBody.text(
					new URLSearchParams(form).toString(),
					"application/x-www-form-urlencoded",
				),
			})
			.pipe(Effect.mapError((cause) => new OAuthFlowError({reason: String(cause)})));
		const json = yield* response.json.pipe(
			Effect.mapError((cause) => new OAuthFlowError({reason: String(cause)})),
		);
		return yield* decodeTokenResponse(json, Date.now());
	});

/** Exchange the authorization code (+ PKCE verifier) for an access + refresh token. */
export const exchangeCodeForTokens = (params: {
	readonly clientId: string;
	readonly code: string;
	readonly codeVerifier: string;
}): Effect.Effect<OAuthConfig, OAuthFlowError, HttpClient.HttpClient> =>
	postTokenForm(
		tokenExchangeForm({
			clientId: params.clientId,
			code: params.code,
			redirectUri: OAUTH_REDIRECT_URI,
			codeVerifier: params.codeVerifier,
		}),
	);

/** Refresh an expired access token; the provider may rotate the refresh token too. */
export const refreshOAuthTokens = (params: {
	readonly clientId: string;
	readonly refreshToken: string;
}): Effect.Effect<OAuthConfig, OAuthFlowError, HttpClient.HttpClient> =>
	postTokenForm(refreshTokenForm(params)).pipe(
		// The provider may omit a rotated refresh_token; keep the one we already hold.
		Effect.map((next) => ({...next, refreshToken: next.refreshToken ?? params.refreshToken})),
	);

const CALLBACK_SUCCESS_HTML =
	"<!doctype html><meta charset=utf-8><title>cf-utils</title>" +
	"<body style=font-family:system-ui;padding:3rem>" +
	"<h1>Authorized.</h1><p>You can close this tab and return to the terminal.</p>";

/**
 * Open the browser (best-effort — always print the URL as the fallback) and block on the
 * loopback callback, resolving the authorization code. A raw `node:http` server on the fixed
 * redirect port is the one-shot primitive this needs; it is closed the moment the callback
 * lands or the effect is interrupted.
 */
const awaitBrowserCallback = (
	authorizeUrl: string,
	expectedState: string,
): Effect.Effect<string, OAuthFlowError> =>
	Effect.callback<string, OAuthFlowError>((resume) => {
		const server = http.createServer((req, res) => {
			const requestUrl = new URL(req.url ?? "/", OAUTH_REDIRECT_URI);
			if (requestUrl.pathname !== OAUTH_CALLBACK_PATH) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, {"content-type": "text/html; charset=utf-8"});
			res.end(CALLBACK_SUCCESS_HTML);
			server.close();
			resume(parseCallbackQuery(requestUrl.searchParams, expectedState));
		});
		server.on("error", (cause) =>
			resume(Effect.fail(new OAuthFlowError({reason: `callback server: ${cause.message}`}))),
		);
		server.listen(OAUTH_CALLBACK_PORT, () => {
			// Best-effort browser open; a spawn failure is non-fatal — the printed URL is the fallback.
			try {
				const opener =
					process.platform === "darwin"
						? "open"
						: process.platform === "win32"
							? "start"
							: "xdg-open";
				void import("node:child_process").then(({spawn}) => {
					spawn(opener, [authorizeUrl], {stdio: "ignore", detached: true}).unref();
				});
			} catch {
				// ignored — the URL was printed for the human to open manually
			}
		});
		return Effect.sync(() => server.close());
	});

export interface OAuthLoginResult {
	readonly tokens: OAuthConfig;
	readonly authorizeUrl: string;
}

/**
 * Run the full browser flow: mint a PKCE verifier + CSRF state, build the authorize URL, wait
 * on the loopback callback, and exchange the code for tokens. Returns the tokens plus the
 * authorize URL so the caller can print it as the manual-open fallback before blocking.
 */
export const runBrowserLogin = (
	clientId: string,
	onAuthorizeUrl: (url: string) => Effect.Effect<void>,
): Effect.Effect<OAuthConfig, OAuthFlowError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const verifier = randomVerifier();
		const state = randomState();
		const authorizeUrl = buildAuthorizeUrl({
			clientId,
			redirectUri: OAUTH_REDIRECT_URI,
			scopes: OAUTH_SCOPES,
			state,
			codeChallenge: pkceChallengeS256(verifier),
		});
		yield* onAuthorizeUrl(authorizeUrl);
		const code = yield* awaitBrowserCallback(authorizeUrl, state);
		return yield* exchangeCodeForTokens({clientId, code, codeVerifier: verifier});
	});
