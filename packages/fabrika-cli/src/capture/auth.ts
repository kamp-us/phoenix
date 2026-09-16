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
 * guess at it.** That value is repo-wide, not per-stage: `infra/ci-credentials/github.ts` mints one
 * `BETTER_AUTH_SECRET` into the ci-credentials stack's alchemy state and pushes it as a write-only
 * Actions secret that `deploy.yml` passes into the deploy of every stage of an app whose worker
 * binds it, so the app stack holds only a `secret_text` binding that does not read back and the one
 * readable copy is that ci-credentials state, behind `$ALCHEMY_PASSWORD` — so the caller names its
 * source ({@link AuthSecretSource}) and this module judges what came back
 * ({@link classifyAuthSecret}). An empty value and a `.env.example` placeholder are both refusals
 * here rather than a cookie the worker rejects at the shot, because the two look identical from the
 * far side: better-auth answers a bad signature and an absent session row with the same bare
 * `null`.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9288#issuecomment-5703250637
 */
import {createHmac} from "node:crypto";
import type {CaptureCookie} from "./capture.ts";
import {CAPTURE_TIERS, type CaptureTier} from "./states.ts";

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
 * The environment variable carrying each tier's session token. One variable per tier, because the
 * token IS the identity: an unset one means `preview-seed test-account` did not seed that tier on
 * this preview, so the refusal below is what stops a surface naming it from falling back to the
 * seeded identity and shooting the wrong audience clean. `preview-seed`'s bin reads the
 * same names on the provisioning side — the two lists move together.
 */
export const TIER_TOKEN_ENV: Readonly<Record<CaptureTier, string>> = {
	yazar: "PREVIEW_TEST_SESSION_TOKEN",
	çaylak: "PREVIEW_TEST_CAYLAK_SESSION_TOKEN",
};

/** The ambient variable a seat carries the signing secret in when no file source is named. */
export const AUTH_SECRET_ENV = "BETTER_AUTH_SECRET";

/**
 * The prefix a repo's example env file ships its throwaway dev secret under. A seat that copied that
 * file to `.env` signs with a value no deployed worker ever verified against, and the worker answers
 * every seeded cookie as a visitor — a fact about the seat's environment that reads, at the shot,
 * exactly like an unseeded preview.
 */
export const PLACEHOLDER_SECRET_PREFIX = "insecure_";

/**
 * Where a run's signing secret came from. It rides every refusal because the two sources fail in
 * opposite directions: a named export that is unreadable is an operator step not taken, and an
 * ambient value that carries the placeholder prefix is a seat quietly signing with a dev key.
 *
 * `RepoWideExport` names the file an operator exported the one repo-wide `BETTER_AUTH_SECRET` into,
 * taken from the ci-credentials stack's alchemy state, its one readable copy.
 */
export type AuthSecretSource =
	| {readonly _tag: "RepoWideExport"; readonly path: string}
	| {readonly _tag: "Ambient"; readonly name: string};

export const describeAuthSecretSource = (source: AuthSecretSource): string =>
	source._tag === "RepoWideExport"
		? `the exported repo-wide session-signing secret at ${source.path}`
		: `the ambient $${source.name}`;

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
 * The credentials an authenticated capture needs for the tiers a run asks for, or what stopped the
 * read. All or nothing: a token with no secret cannot be signed, a secret with no token names no
 * session, and a tier with no token of its own is a tier this preview does not carry.
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
			readonly tokens: Readonly<Partial<Record<CaptureTier, string>>>;
			readonly secret: string;
	  }
	| {readonly _tag: "Missing"; readonly names: readonly string[]}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Fold the tier tokens read off `env` together with an already-resolved secret.
 *
 * The secret arrives as an argument rather than off `env` because its source is the caller's
 * decision — a named export of the deployed value, or the ambient variable — and a
 * pure core cannot read a file. An unusable secret is reported ahead of any unset token: the tokens
 * are the operator's own `preview-seed` output and read back plainly, where the secret is the half
 * that has been silently wrong.
 */
export const readIdentity = (
	env: Readonly<Record<string, string | undefined>>,
	tiers: readonly CaptureTier[],
	secret: AuthSecretRead,
): IdentityRead => {
	const wanted = CAPTURE_TIERS.filter((tier) => tiers.includes(tier));
	const found = wanted.map((tier) => [tier, env[TIER_TOKEN_ENV[tier]] ?? ""] as const);
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
	const names = found.flatMap(([tier, token]) =>
		token.length === 0 ? [TIER_TOKEN_ENV[tier]] : [],
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
 * Whether a capture context is signed in **and at which tier**, decided from the probe's own
 * answer. The tier rides here because signed-in is not the whole question: an `:auth` surface whose
 * audience is defined by *not* clearing the lowest tier's floor renders clean and wrong when the
 * shot came back as somebody above it.
 *
 * `user.tier` is on the answer because the app declares it in better-auth's
 * `additionalUserFields` without `returned: false` — the flag a private field would carry and
 * `tier` deliberately does not.
 *
 * Three arms, not two: a probe that could not be read is UNKNOWN and must not collapse into
 * "anonymous", because both would refuse but only one of them is a fact about the session. A signed
 * in user whose tier the answer does not carry is Unreadable for the same reason — the tier is
 * unknown, not wrong.
 */
export type SessionProof =
	| {readonly _tag: "SignedIn"; readonly userId: string; readonly tier: string}
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
	if (typeof id !== "string" || id.length === 0) {
		return {_tag: "Unreadable", reason: "probe named a user with no id"};
	}
	const tier = (user as {tier?: unknown}).tier;
	return typeof tier === "string" && tier.length > 0
		? {_tag: "SignedIn", userId: id, tier}
		: {_tag: "Unreadable", reason: "probe named a user with no tier"};
};
