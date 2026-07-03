/**
 * The Cloudflare browser OAuth flow (#1761) — Authorization-Code + PKCE, the `wrangler login`
 * model — as an ALTERNATIVE credential-acquisition path to the #1730 token-paste flow. It
 * authorizes in the browser so no API-token secret ever crosses the terminal (the founder
 * streams his release workflow on Twitch; a pasted token leaks on the VOD, an OAuth
 * browser-authorize does not).
 *
 * The endpoints, the public PKCE client id, the redirect URI, and the PKCE/state derivation
 * are grounded in alchemy's own Cloudflare OAuth provider (`alchemy/src/Cloudflare/Auth/
 * OAuthClient.ts` + `AuthProvider.ts`), which implements the same wrangler flow — not
 * intuition (CLAUDE.md grounding rule).
 *
 * SCOPE CAVEAT (AC#3 — read before changing `FLAGSHIP_OAUTH_SCOPES`): OAuth scope names map
 * 1:1 to Cloudflare API-token permission names, and as of writing there is NO documented
 * Flagship/feature-flag OAuth scope in Cloudflare's published catalog (verified against the
 * wrangler/alchemy scope list, which enumerates ~70 scopes and carries no `flagship:*`). The
 * exact scope strings this flow requests are therefore a **documented, single-point config
 * constant** below, NOT magic strings buried in the flow — so when the founder confirms the
 * real scope id via the dashboard's `GET /oauth/scopes` this is a one-line change. Until then
 * token-paste (#1730) remains the FULL-coverage path; OAuth is first-class-but-pending-scope.
 *
 * The pure surface here (PKCE, state, the refresh decision, the authorize-URL builder) is
 * IO-free and unit-tested off-network (ADR 0082); the IO surface (local callback server,
 * browser open, token HTTP exchange) is thin over `node:http` / `node:crypto` and `fetch`.
 */
import {createHash, randomBytes} from "node:crypto";
import {createServer} from "node:http";
import {Data, Effect} from "effect";
import {ChildProcess, type ChildProcessSpawner} from "effect/unstable/process";

/** The public (PKCE, no-secret) OAuth client the founder registers once in the CF dashboard. */
export const OAUTH_CLIENT_ID = "6d8c2255-0773-45f6-b376-2914632e6f91";

/** The loopback redirect the local callback server listens on (host:port + path). */
export const OAUTH_REDIRECT_URI = "http://localhost:9976/auth/callback";

/** The Cloudflare OAuth2 endpoints (same host wrangler/alchemy use). */
export const OAUTH_ENDPOINTS = {
	authorize: "https://dash.cloudflare.com/oauth2/authorize",
	token: "https://dash.cloudflare.com/oauth2/token",
	revoke: "https://dash.cloudflare.com/oauth2/revoke",
} as const;

/**
 * The scopes the flow requests to cover cf-utils' Flagship read+write flag operations (AC#3).
 *
 * SINGLE POINT OF CHANGE. `flagship:read` / `flagship:write` follow Cloudflare's
 * `<resource>:<verb>` scope convention, but are NOT yet confirmed to exist in CF's published
 * OAuth-scope catalog (see the SCOPE CAVEAT in the file docblock). When the founder confirms
 * the real Flagship scope id (or that a scope-down / different id is needed) via the dashboard
 * `GET /oauth/scopes`, edit THIS array — nothing else in the flow hardcodes a scope string.
 *
 * `account:read` + `user:read` are the always-needed enumeration scopes (listing accounts to
 * resolve the account id); `offline_access` is appended by `authorize()` and is what makes CF
 * issue a refresh token — omitting it yields an access-token-only grant with no refresh path.
 */
export const FLAGSHIP_OAUTH_SCOPES = [
	"flagship:read",
	"flagship:write",
	"account:read",
	"user:read",
] as const;

/** The scope that makes Cloudflare issue a refresh token alongside the access token. */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/**
 * The access token is refreshed this many ms BEFORE its stated expiry, so an in-flight call
 * never races the expiry boundary. Matches the `@distilled.cloud/cloudflare` OAuth provider's
 * own 5-minute refresh window, so `credentials.ts`'s persisted `expiresAt` and the SDK's
 * `fromOAuth` refresh trigger agree.
 */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** The OAuth token set as acquired/refreshed — the shape persisted through the keychain seam. */
export interface OAuthTokens {
	readonly accessToken: string;
	readonly refreshToken: string;
	/** Absolute expiry as epoch-ms (Date.now() + expires_in*1000 at acquisition). */
	readonly expiresAt: number;
	readonly scopes: ReadonlyArray<string>;
}

/** A single authorization attempt's PKCE material + CSRF state + the browser URL. */
export interface Authorization {
	readonly url: string;
	readonly state: string;
	readonly verifier: string;
}

/** The token endpoint (or callback) returned an error, or the flow failed. No secret rides it. */
export class OAuthError extends Data.TaggedError("@kampus/cf-utils/OAuthError")<{
	readonly error: string;
	readonly errorDescription: string;
}> {
	override get message(): string {
		return `OAuth failed: ${this.error} — ${this.errorDescription}`;
	}
}

// ─── pure core (IO-free, unit-tested off-network) ──────────────────────────────────────────

/** A URL-safe CSRF `state` nonce (128 bits of entropy, base64url). */
export const generateState = (): string => randomBytes(16).toString("base64url");

/**
 * A PKCE verifier + its S256 challenge (RFC 7636). The verifier is a high-entropy base64url
 * secret held locally; the challenge (`base64url(sha256(verifier))`) is what rides the public
 * authorize URL, so the code can only be exchanged by the holder of the verifier.
 */
export const generatePkce = (): {readonly verifier: string; readonly challenge: string} => {
	const verifier = randomBytes(64).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return {verifier, challenge};
};

/**
 * Build the browser authorization URL for the given scopes, minting fresh PKCE + state.
 * `offline_access` is appended unconditionally so the grant returns a refresh token.
 */
export const authorize = (scopes: ReadonlyArray<string>): Authorization => {
	const state = generateState();
	const {verifier, challenge} = generatePkce();
	const url = new URL(OAUTH_ENDPOINTS.authorize);
	url.searchParams.set("client_id", OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", [...scopes, OFFLINE_ACCESS_SCOPE].join(" "));
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	return {url: url.toString(), state, verifier};
};

/**
 * The refresh DECISION, pure and total: given the persisted expiry and a clock, should the
 * stored access token be refreshed before use? True when it is expired or within the refresh
 * window. `undefined` expiry (an access-token-only grant with no known expiry) never refreshes.
 */
export const shouldRefresh = (expiresAt: number | undefined, now: number): boolean =>
	expiresAt !== undefined && now >= expiresAt - REFRESH_WINDOW_MS;

/** Convert a token endpoint response body into the persisted `OAuthTokens`, stamping expiry. */
export const tokensFromResponse = (
	json: {
		readonly access_token: string;
		readonly refresh_token: string;
		readonly expires_in: number;
		readonly scope: string;
	},
	now: number,
): OAuthTokens => ({
	accessToken: json.access_token,
	refreshToken: json.refresh_token,
	expiresAt: now + json.expires_in * 1000,
	scopes: json.scope.length > 0 ? json.scope.split(" ") : [],
});

// ─── IO surface (thin over fetch / node:http; not part of the pure tier) ────────────────────

const tokenRequest = (body: Record<string, string>): Effect.Effect<OAuthTokens, OAuthError> =>
	Effect.gen(function* () {
		const res = yield* Effect.tryPromise({
			try: () =>
				fetch(OAUTH_ENDPOINTS.token, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams(body).toString(),
				}),
			catch: (cause) =>
				new OAuthError({
					error: "network_error",
					errorDescription: `token request failed: ${cause}`,
				}),
		});
		if (!res.ok) {
			const errJson = yield* Effect.tryPromise({
				try: () => res.json() as Promise<{error?: string; error_description?: string}>,
				catch: () =>
					new OAuthError({
						error: "parse_error",
						errorDescription: `token endpoint returned ${res.status}`,
					}),
			});
			return yield* new OAuthError({
				error: errJson.error ?? "token_error",
				errorDescription: errJson.error_description ?? `token endpoint returned ${res.status}`,
			});
		}
		const json = yield* Effect.tryPromise({
			try: () =>
				res.json() as Promise<{
					access_token: string;
					refresh_token: string;
					expires_in: number;
					scope: string;
				}>,
			catch: () =>
				new OAuthError({error: "parse_error", errorDescription: "failed to parse token response"}),
		});
		return tokensFromResponse(json, Date.now());
	});

/** Exchange an authorization code (+ its PKCE verifier) for the token set. */
export const exchange = (code: string, verifier: string): Effect.Effect<OAuthTokens, OAuthError> =>
	tokenRequest({
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: OAUTH_REDIRECT_URI,
	});

/** Exchange a refresh token for a fresh token set. */
export const refresh = (refreshToken: string): Effect.Effect<OAuthTokens, OAuthError> =>
	tokenRequest({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: OAUTH_REDIRECT_URI,
	});

/**
 * Best-effort open the authorization URL in the default browser via the platform opener
 * (`open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows). Never fails the flow: a
 * missing opener/headless host succeeds silently — the caller always also prints the URL for a
 * manual copy, so the flow proceeds whether or not the browser auto-opened.
 */
export const openBrowser = (
	url: string,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const [command, args] =
			process.platform === "darwin"
				? ["open", [url]]
				: process.platform === "win32"
					? ["cmd", ["/c", "start", "", url]]
					: ["xdg-open", [url]];
		const handle = yield* ChildProcess.make(command as string, args as ReadonlyArray<string>);
		yield* handle.exitCode;
	}).pipe(
		Effect.scoped,
		// A missing opener binary / headless host must not abort login — the URL is printed too.
		Effect.ignore,
	);

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the local loopback callback server: wait for CF to redirect back with `?code&state`,
 * verify `state` against the authorization's (CSRF), exchange the code, and resolve the tokens.
 * Times out after 5 minutes; every exit path closes the server. Bound to the redirect URI's
 * host:port — a public browser can only reach it over loopback.
 */
export const awaitCallback = (auth: Authorization): Effect.Effect<OAuthTokens, OAuthError> =>
	Effect.tryPromise({
		try: () => callbackPromise(auth),
		catch: (cause) =>
			cause instanceof OAuthError
				? cause
				: new OAuthError({error: "callback_error", errorDescription: `callback failed: ${cause}`}),
	});

const callbackPromise = (auth: Authorization): Promise<OAuthTokens> => {
	const {pathname, port} = new URL(OAUTH_REDIRECT_URI);
	return new Promise<OAuthTokens>((resolve, reject) => {
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			if (url.pathname !== pathname) {
				res.statusCode = 404;
				res.end("Not Found");
				return;
			}
			const fail = (error: string, errorDescription: string) => {
				res.statusCode = 400;
				res.end(`${error}: ${errorDescription}`);
				cleanup();
				reject(new OAuthError({error, errorDescription}));
			};
			const error = url.searchParams.get("error");
			if (error) {
				fail(error, url.searchParams.get("error_description") ?? "authorization denied");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code || !state) {
				fail("invalid_request", "missing code or state");
				return;
			}
			if (state !== auth.state) {
				fail("invalid_state", "state mismatch — possible CSRF, aborting");
				return;
			}
			Effect.runPromise(exchange(code, auth.verifier)).then(
				(tokens) => {
					res.statusCode = 200;
					res.setHeader("Content-Type", "text/html; charset=utf-8");
					res.end(SUCCESS_PAGE);
					cleanup();
					resolve(tokens);
				},
				(cause) => {
					res.statusCode = 500;
					res.end("Authorization failed. You can close this window and check the terminal.");
					cleanup();
					reject(cause);
				},
			);
		});
		const timer = setTimeout(() => {
			cleanup();
			reject(new OAuthError({error: "timeout", errorDescription: "authorization timed out"}));
		}, CALLBACK_TIMEOUT_MS);
		const cleanup = () => {
			clearTimeout(timer);
			server.close();
		};
		server.on("error", (err) =>
			reject(new OAuthError({error: "server_error", errorDescription: err.message})),
		);
		server.listen(Number(port));
	});
};

const SUCCESS_PAGE =
	"<!doctype html><meta charset=utf-8><title>cf-utils</title>" +
	'<body style="font:16px system-ui;padding:3rem"><h1>Authorized.</h1>' +
	"<p>You can close this window and return to the terminal.</p></body>";
