/**
 * Build the better-auth session cookie a capture context presents, so `review-ui render` can shoot
 * a surface behind login. Pure — no browser, no network; `capture.ts` seeds what this
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
 * which an app commonly does on preview — so it is a fact about the running worker
 * that no caller out here can observe. The server reads exactly one name and ignores the other.
 *
 * **The signing key is the one the deployed worker verifies against, and this module refuses to
 * guess at it.** A `pr-<n>` preview worker verifies against the preview key committed at
 * `infra/preview-auth-key/key.txt` — public on purpose, so a seat needs no credential at all — and
 * production keeps the founder-held `BETTER_AUTH_SECRET` no agent holds a copy of. So the caller
 * names its source ({@link AuthSecretSource}) and this module judges what came back
 * ({@link classifyAuthSecret}). An empty value and a `.env.example` placeholder are both refusals
 * here rather than a cookie the worker rejects at the shot, because the two look identical from the
 * far side: better-auth answers a bad signature and an absent session row with the same bare
 * `null`. The committed preview key is neither, so it passes — `auth.unit.test.ts` reads the real
 * file and asserts that, because a refusal here would strand every signed-in render on a value the
 * repo hands out freely.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9288#issuecomment-5703250637
 * @ruling https://github.com/kamp-us/phoenix/issues/9533#issuecomment-5754589033
 */
import {createHmac} from "node:crypto";
import {Redacted} from "effect";
import {isRecord, parseJsonOrReason} from "../io/json.ts";
import type {CaptureCookie} from "./capture.ts";
import {CAPTURE_IDENTITIES, type CaptureIdentity} from "./states.ts";

export const SESSION_COOKIE_BASENAME = "better-auth.session_token";
export const SECURE_COOKIE_PREFIX = "__Secure-";

/** The signed cookie value better-auth would have written for this session token. */
export const signSessionToken = (token: string, secret: string): string =>
	encodeURIComponent(
		`${token}.${createHmac("sha256", secret).update(token, "utf8").digest("base64")}`,
	);

/**
 * The session cookies to seed for a preview base URL — the prefixed and unprefixed names, both
 * carrying the same signed value. This is the one place a token is unwrapped: the cookie the
 * browser context presents.
 */
export const sessionCookies = (
	previewUrl: string,
	token: Redacted.Redacted<string>,
	secret: string,
): readonly CaptureCookie[] => {
	const value = signSessionToken(Redacted.value(token), secret);
	const secure = new URL(previewUrl).protocol === "https:";
	const names = secure
		? [SESSION_COOKIE_BASENAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASENAME}`]
		: [SESSION_COOKIE_BASENAME];
	return names.map((name) => ({name, value, url: previewUrl, secure}));
};

/**
 * The environment variable carrying each identity's session token. One variable per identity,
 * because the token IS the identity: an unset one is fetched from the repository variable, and one
 * found in neither place is refused, which is what stops a surface naming it from falling back to
 * a seeded one and shooting the wrong audience clean. `preview-seed`'s `logins.ts` holds the same
 * names on the provisioning side — the two lists move together.
 */
export const IDENTITY_TOKEN_ENV: Readonly<Record<CaptureIdentity, string>> = {
	yazar: "PREVIEW_TEST_SESSION_TOKEN",
	çaylak: "PREVIEW_TEST_CAYLAK_SESSION_TOKEN",
	"çaylak-unverified": "PREVIEW_TEST_CAYLAK_UNVERIFIED_SESSION_TOKEN",
};

/**
 * The repository variable that carries every identity's token as one JSON object keyed by the
 * names in {@link IDENTITY_TOKEN_ENV}. It is where a seat with no token in its environment gets
 * one: reading it takes repository access and nothing else. `preview-seed`'s `logins.ts` writes
 * the same shape — the two move together.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10330
 */
export const LOGINS_VARIABLE = "PREVIEW_TEST_LOGINS";

/** One token per identity, each held `Redacted` so nothing that prints this value prints a login. */
export type IdentityTokens = Readonly<Partial<Record<CaptureIdentity, Redacted.Redacted<string>>>>;

export type LoginsRead =
	| {readonly _tag: "Parsed"; readonly tokens: IdentityTokens}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * Read the {@link LOGINS_VARIABLE} value. Every `reason` is composed here and never quotes the
 * input: the runtime's own `JSON.parse` message carries a slice of the text it failed on, which
 * for this value is a slice of a login.
 */
export const parseLogins = (raw: Redacted.Redacted<string>): LoginsRead => {
	const read = parseJsonOrReason(Redacted.value(raw));
	if (read._tag === "Failed") return {_tag: "Malformed", reason: "it is not JSON"};
	const parsed = read.value;
	if (!isRecord(parsed)) return {_tag: "Malformed", reason: "it is not a JSON object"};
	const tokens: Partial<Record<CaptureIdentity, Redacted.Redacted<string>>> = {};
	for (const identity of Object.keys(CAPTURE_IDENTITIES) as CaptureIdentity[]) {
		const value = parsed[IDENTITY_TOKEN_ENV[identity]];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			return {_tag: "Malformed", reason: `its ${IDENTITY_TOKEN_ENV[identity]} is not a string`};
		}
		if (value.length > 0) tokens[identity] = Redacted.make(value);
	}
	return {_tag: "Parsed", tokens};
};

/** The ambient variable a seat carries the signing secret in when no file source is named. */
export const AUTH_SECRET_ENV = "BETTER_AUTH_SECRET";

/**
 * The repo-relative home of the key every `pr-<n>` preview worker deploys with. It is committed and
 * deliberately public, so this is the source that needs no flag, no environment variable and no
 * credential a seat might not hold — the route that stopped ending every `:auth` render on a person
 * (`infra/preview-auth-key/README.md`).
 */
export const PREVIEW_AUTH_KEY_PATH = "infra/preview-auth-key/key.txt";

/**
 * The prefix a repo's example env file ships its throwaway dev secret under. A seat that copied that
 * file to `.env` signs with a value no deployed worker ever verified against, and the worker answers
 * every seeded cookie as a visitor — a fact about the seat's environment that reads, at the shot,
 * exactly like an unseeded preview.
 */
export const PLACEHOLDER_SECRET_PREFIX = "insecure_";

/**
 * Where a run's signing secret came from. It rides every refusal because the three sources fail in
 * different directions: a named export that is unreadable is an operator step not taken, an ambient
 * value that carries the placeholder prefix is a seat quietly signing with a dev key, and a
 * committed preview key that came back unusable is a repo defect rather than anything the seat did.
 *
 * `RepoWideExport` names the file an operator exported the founder-held `BETTER_AUTH_SECRET` into.
 * `CommittedPreviewKey` names the repo's own {@link PREVIEW_AUTH_KEY_PATH}, which is the default and
 * the one source a seat holding no credentials can still use.
 */
export type AuthSecretSource =
	| {readonly _tag: "RepoWideExport"; readonly path: string}
	| {readonly _tag: "CommittedPreviewKey"; readonly path: string}
	| {readonly _tag: "Ambient"; readonly name: string};

export const describeAuthSecretSource = (source: AuthSecretSource): string => {
	switch (source._tag) {
		case "RepoWideExport":
			return `the exported session-signing secret at ${source.path}`;
		case "CommittedPreviewKey":
			return `the committed preview signing key at ${source.path}`;
		case "Ambient":
			return `the ambient $${source.name}`;
	}
};

/**
 * A secret value judged against its source. `Placeholder` and `Empty` are two different facts about
 * the same unusable state, and neither is ever folded into the other: one says a value was read and
 * is the wrong one, the other says there was nothing to read.
 */
export type AuthSecretRead =
	| {readonly _tag: "Usable"; readonly value: string; readonly source: AuthSecretSource}
	| {readonly _tag: "Placeholder"; readonly source: AuthSecretSource}
	| {readonly _tag: "Empty"; readonly source: AuthSecretSource};

/**
 * Judge one read value. The placeholder test runs on the trimmed value because a file export ends
 * in a newline far more often than not, and a trailing byte in the signing key is the same silent
 * visitor answer this whole path exists to stop.
 */
export const classifyAuthSecret = (raw: string, source: AuthSecretSource): AuthSecretRead => {
	const value = raw.trim();
	if (value.length === 0) return {_tag: "Empty", source};
	if (value.startsWith(PLACEHOLDER_SECRET_PREFIX)) return {_tag: "Placeholder", source};
	return {_tag: "Usable", value, source};
};

/**
 * The credentials an authenticated capture needs for the identities a run asks for, or what stopped
 * the read. All or nothing: a token with no secret cannot be signed, a secret with no token names no
 * session, and an identity with no token of its own is one this preview does not carry.
 *
 * `Unusable` is its own arm rather than another name on `Missing`'s list, because the secret is no
 * longer an environment variable among others: it is the value the deployed worker verifies
 * against, and a seat
 * holding the wrong one produces a perfectly well-formed cookie the worker refuses. Collapsing the
 * two spent two review rounds reading "the preview answered the seeded cookie as a visitor" without
 * being able to say which of a wrong key and a missing row it was.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9288#issuecomment-5703250637
 */
export type IdentityRead =
	| {
			readonly _tag: "Identity";
			readonly tokens: IdentityTokens;
			readonly secret: string;
	  }
	| {readonly _tag: "Missing"; readonly names: readonly string[]}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Fold the identity tokens together with an already-resolved secret. A token set in `env` wins;
 * `fetched` — the {@link LOGINS_VARIABLE} tokens, when the caller went and read them — fills only
 * the identities `env` leaves unset.
 *
 * The secret arrives as an argument rather than off `env` because its source is the caller's
 * decision — a named export of the deployed value, or the ambient variable — and a
 * pure core cannot read a file. An unusable secret is reported ahead of any unset token: the tokens
 * are the operator's own `preview-seed` output and read back plainly, where the secret is the half
 * that has been silently wrong.
 */
export const readIdentity = (
	env: Readonly<Record<string, string | undefined>>,
	identities: readonly CaptureIdentity[],
	secret: AuthSecretRead,
	fetched: IdentityTokens = {},
): IdentityRead => {
	const wanted = (Object.keys(CAPTURE_IDENTITIES) as CaptureIdentity[]).filter((identity) =>
		identities.includes(identity),
	);
	const found = wanted.map((identity) => {
		const ambient = env[IDENTITY_TOKEN_ENV[identity]] ?? "";
		return [
			identity,
			ambient.length > 0 ? Redacted.make(ambient) : (fetched[identity] ?? null),
		] as const;
	});
	if (secret._tag === "Placeholder") {
		return {
			_tag: "Unusable",
			reason: `${describeAuthSecretSource(secret.source)} carries the ${PLACEHOLDER_SECRET_PREFIX} placeholder prefix — a cookie signed with it is one the preview worker answers as a visitor`,
		};
	}
	if (secret._tag === "Empty") {
		return {
			_tag: "Unusable",
			reason: `${describeAuthSecretSource(secret.source)} is empty — there is no key to sign the tier cookie with`,
		};
	}
	const names = found.flatMap(([identity, token]) =>
		token === null ? [IDENTITY_TOKEN_ENV[identity]] : [],
	);
	return names.length === 0
		? {_tag: "Identity", tokens: Object.fromEntries(found), secret: secret.value}
		: {_tag: "Missing", names};
};

/**
 * The preview endpoint that answers whether the seeded cookie actually authenticates.
 *
 * better-auth's `/get-session` (`dist/api/routes/session.mjs` at the `1.6.23` pin) reads the signed
 * session cookie and returns a bare JSON `null` when it does not resolve to a session, or an object
 * carrying `session` + `user` when it does — so the answer is decidable from the body alone, without
 * reading a pixel. The app mounts better-auth's routes at `/api/auth/*`.
 */
export const SESSION_PROBE_PATH = "/api/auth/get-session";

/**
 * Whether a capture context is signed in **and as which audience**, decided from the probe's own
 * answer. The tier and the email-verification standing ride here because signed-in is not the whole
 * question: an `:auth` surface whose audience is defined by *not* clearing a floor — the lowest
 * tier's, or a verified address's — renders clean and wrong when the shot came back as somebody
 * above it.
 *
 * `user.tier` is on the answer because the app declares it in better-auth's
 * `additionalUserFields` without `returned: false` — the flag a private field would carry and
 * `tier` deliberately does not. `user.emailVerified` is better-auth's own core user field, which
 * carries no `returned: false` either (`@better-auth/core` `dist/db/get-tables.mjs` at the `1.6.23`
 * pin), so `/get-session` returns it through `parseUserOutput` on every signed-in answer.
 *
 * Three arms, not two: a probe that could not be read is UNKNOWN and must not collapse into
 * "anonymous", because both would refuse but only one of them is a fact about the session. A signed
 * in user whose tier or verification the answer does not carry is Unreadable for the same reason —
 * the audience is unknown, not wrong.
 *
 * `Anonymous` carries which of the two visitor answers it was ({@link VisitorCause}), because the
 * fix for each is in a different place.
 */
export type SessionProof =
	| {
			readonly _tag: "SignedIn";
			readonly userId: string;
			readonly tier: string;
			readonly emailVerified: boolean;
	  }
	| {readonly _tag: "Anonymous"; readonly cause: VisitorCause}
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * Why the preview answered a seeded cookie as a visitor. The body is the same bare `null` either
 * way, and the response headers are what tell the two apart. In better-auth's `getSession`
 * (`dist/api/routes/session.mjs` at the `1.6.23` pin) a cookie whose signature does not verify
 * returns before anything else runs, setting no cookie. A cookie that verifies but names no live
 * session row calls `deleteSessionCookie`, which answers with a `Set-Cookie` expiring the session
 * cookie (`Max-Age=0`, `dist/cookies/index.mjs`).
 *
 * `BadSignature` means the signing key this run used is not the one the worker verifies with.
 * `NoSessionRow` means the key is right and the preview's database holds no unexpired session for
 * this token: the preview was not seeded with it, or was seeded with a different one.
 */
export type VisitorCause = "BadSignature" | "NoSessionRow";

/** Whether a `Set-Cookie` header expires the session cookie, under either of its two names. */
const expiresSessionCookie = (setCookie: string): boolean => {
	const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
	const name = pair.slice(0, pair.indexOf("="));
	return (
		(name === SESSION_COOKIE_BASENAME ||
			name === `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_BASENAME}`) &&
		attributes.some((attribute) => /^max-age=0$/i.test(attribute))
	);
};

export const visitorCauseOf = (setCookies: readonly string[]): VisitorCause =>
	setCookies.some(expiresSessionCookie) ? "NoSessionRow" : "BadSignature";

/** `setCookies` is every `Set-Cookie` header the probe's response carried, one string per header. */
export const readSessionProof = (
	status: number,
	body: string,
	setCookies: readonly string[],
): SessionProof => {
	if (status !== 200) return {_tag: "Unreadable", reason: `probe answered ${status}`};
	const read = parseJsonOrReason(body);
	if (read._tag === "Failed") return {_tag: "Unreadable", reason: "probe body is not JSON"};
	const parsed = read.value;
	const visitor: SessionProof = {_tag: "Anonymous", cause: visitorCauseOf(setCookies)};
	if (parsed === null) return visitor;
	if (typeof parsed !== "object") {
		return {_tag: "Unreadable", reason: "probe body is not a session object"};
	}
	const user = (parsed as {user?: unknown}).user;
	if (user === null || user === undefined) return visitor;
	const id = (user as {id?: unknown}).id;
	if (typeof id !== "string" || id.length === 0) {
		return {_tag: "Unreadable", reason: "probe named a user with no id"};
	}
	const tier = (user as {tier?: unknown}).tier;
	if (typeof tier !== "string" || tier.length === 0) {
		return {_tag: "Unreadable", reason: "probe named a user with no tier"};
	}
	const emailVerified = (user as {emailVerified?: unknown}).emailVerified;
	return typeof emailVerified === "boolean"
		? {_tag: "SignedIn", userId: id, tier, emailVerified}
		: {_tag: "Unreadable", reason: "probe named a user with no emailVerified"};
};
