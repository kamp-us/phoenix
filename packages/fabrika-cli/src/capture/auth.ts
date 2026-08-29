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
 * The credentials an authenticated capture needs, or the names of whichever are unset. Both or
 * neither: a token with no secret cannot be signed, and a secret with no token names no session, so
 * a complete pair is the only arm that renders signed in — one unset name and two are the same
 * refusal, differing only in what they list.
 */
export type IdentityRead =
	| {readonly _tag: "Identity"; readonly token: string; readonly secret: string}
	| {readonly _tag: "Missing"; readonly names: readonly string[]};

export const readIdentity = (env: Readonly<Record<string, string | undefined>>): IdentityRead => {
	const token = env.PREVIEW_TEST_SESSION_TOKEN ?? "";
	const secret = env.BETTER_AUTH_SECRET ?? "";
	const names = [
		...(token.length === 0 ? ["PREVIEW_TEST_SESSION_TOKEN"] : []),
		...(secret.length === 0 ? ["BETTER_AUTH_SECRET"] : []),
	];
	return names.length === 0 ? {_tag: "Identity", token, secret} : {_tag: "Missing", names};
};

/**
 * The preview endpoint that answers whether the seeded cookie actually authenticates.
 *
 * better-auth's `/get-session` (`dist/api/routes/session.mjs` at the `1.6.23` pin) reads the signed
 * session cookie and returns a bare JSON `null` when it does not resolve to a session, or an object
 * carrying `session` + `user` when it does — so the answer is decidable from the body alone, without
 * reading a pixel. Mounted at `/api/auth/*` by `apps/web/worker/features/pasaport/route.ts`.
 */
export const SESSION_PROBE_PATH = "/api/auth/get-session";

/**
 * Whether a capture context is signed in, decided from the probe's own answer.
 *
 * Three arms, not two: a probe that could not be read is UNKNOWN and must not collapse into
 * "anonymous", because both would refuse but only one of them is a fact about the session.
 */
export type SessionProof =
	| {readonly _tag: "SignedIn"; readonly userId: string}
	| {readonly _tag: "Anonymous"}
	| {readonly _tag: "Unreadable"; readonly reason: string};

export const readSessionProof = (status: number, body: string): SessionProof => {
	if (status !== 200) return {_tag: "Unreadable", reason: `probe answered ${status}`};
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return {_tag: "Unreadable", reason: "probe body is not JSON"};
	}
	if (parsed === null) return {_tag: "Anonymous"};
	if (typeof parsed !== "object") {
		return {_tag: "Unreadable", reason: "probe body is not a session object"};
	}
	const user = (parsed as {user?: unknown}).user;
	if (user === null || user === undefined) return {_tag: "Anonymous"};
	const id = (user as {id?: unknown}).id;
	return typeof id === "string" && id.length > 0
		? {_tag: "SignedIn", userId: id}
		: {_tag: "Unreadable", reason: "probe named a user with no id"};
};
