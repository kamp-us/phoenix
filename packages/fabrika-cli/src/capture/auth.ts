/**
 * Build the better-auth session cookie a capture context presents, so `review-ui render` can shoot
 * a surface behind login (#7051). Pure — no browser, no network; `capture.ts` seeds what this
 * returns.
 *
 * The wire format is better-auth's, read at the pinned version rather than assumed:
 * `setSessionCookie` writes the session row's `token` through `ctx.setSignedCookie(…,
 * ctx.context.secret)` (better-auth `dist/cookies/index.mjs`), and `setSignedCookie` resolves to
 * better-call's `signCookieValue` (`dist/crypto.mjs`) — `encodeURIComponent(`${value}.${base64(
 * HMAC-SHA256(value, secret))}`)`. The read side (`dist/api/routes/session.mjs`) verifies that
 * signature, so an unsigned token is simply not a session.
 *
 * Two cookie names are seeded, not one, and that is deliberate. The `__Secure-` prefix is chosen
 * inside the worker isolate from `isProduction` when the app configures `baseURL` as an object —
 * which phoenix does on preview (`deriveAuthUrlConfig`) — so it is a fact about the running worker
 * that no caller out here can observe. The server reads exactly one name and ignores the other.
 */
import {createHmac} from "node:crypto";
import type {CaptureCookie} from "./capture.ts";

export const SESSION_COOKIE_BASENAME = "better-auth.session_token";
export const SECURE_COOKIE_PREFIX = "__Secure-";

/** The signed cookie value better-auth would have written for this session token. */
export const signSessionToken = (token: string, secret: string): string =>
	encodeURIComponent(
		`${token}.${createHmac("sha256", secret).update(token, "utf8").digest("base64")}`,
	);

/**
 * The session cookies to seed for a preview base URL — the prefixed and unprefixed names, both
 * carrying the same signed value.
 */
export const sessionCookies = (
	previewUrl: string,
	token: string,
	secret: string,
): readonly CaptureCookie[] => {
	const value = signSessionToken(token, secret);
	const secure = new URL(previewUrl).protocol === "https:";
	const names = secure
		? [SESSION_COOKIE_BASENAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASENAME}`]
		: [SESSION_COOKIE_BASENAME];
	return names.map((name) => ({name, value, url: previewUrl, secure}));
};

/**
 * The credentials an authenticated capture needs. Both or neither: a token with no secret cannot be
 * signed, and a secret with no token names no session, so the pair is the only representable state.
 */
export interface CaptureIdentity {
	readonly token: string;
	readonly secret: string;
}

/**
 * Read the identity from the environment. Returns `null` when neither is set (the anonymous
 * capture, which is the default) and the name of the missing half when exactly one is — a half-set
 * pair is a misconfiguration that would otherwise render anonymously and read as a clean default.
 */
export const readIdentity = (
	env: Readonly<Record<string, string | undefined>>,
): CaptureIdentity | null | {readonly missing: string} => {
	const token = env.PREVIEW_TEST_SESSION_TOKEN ?? "";
	const secret = env.BETTER_AUTH_SECRET ?? "";
	if (token.length === 0 && secret.length === 0) return null;
	if (token.length === 0) return {missing: "PREVIEW_TEST_SESSION_TOKEN"};
	if (secret.length === 0) return {missing: "BETTER_AUTH_SECRET"};
	return {token, secret};
};
