/**
 * The preview test logins as one value, and the two things done with it: resolve the tokens a
 * `test-account` run provisions, and mint a fresh set for `rotate-logins`.
 *
 * GitHub stores that one value twice under {@link LOGINS_NAME}: as an Actions secret, which the
 * deploy workflow hands `test-account` so every preview is seeded, and as a repository variable,
 * which only agents fetch and no workflow reads. Both hold the same JSON object, keyed by the
 * per-identity variable names in {@link IDENTITY_TOKEN_ENV}, so the format adds no third vocabulary.
 * `fabrika-cli`'s `capture/auth.ts` parses the same shape on the capture side — the two move together.
 *
 * GitHub masks a secret's whole value in a log and nothing inside it, so the tokens in this object
 * are not masked individually. Every value here is therefore `Redacted` from the read on, and every
 * refusal is worded without quoting what it read.
 *
 * Ruled in https://github.com/kamp-us/phoenix/issues/10330 (R5.1, R7.1), specified in
 * https://github.com/kamp-us/phoenix/issues/9281.
 */
import {randomBytes} from "node:crypto";
import {Effect, Redacted} from "effect";
import {parseJson} from "./json.ts";
import {
	PREVIEW_IDENTITIES,
	type PreviewCredentials,
	type PreviewIdentity,
	parseSessionToken,
} from "./test-account.ts";

/**
 * The environment variable carrying each identity's session token. One variable per identity,
 * because the token IS the identity: a single variable reused across identities would make a
 * mistyped run provision the wrong audience under the right name. `review-ui render` reads the same
 * names on the capture side (`fabrika-cli`'s `capture/auth.ts`) — the two lists move together.
 */
export const IDENTITY_TOKEN_ENV: Readonly<Record<PreviewIdentity, string>> = {
	yazar: "PREVIEW_TEST_SESSION_TOKEN",
	çaylak: "PREVIEW_TEST_CAYLAK_SESSION_TOKEN",
	"çaylak-unverified": "PREVIEW_TEST_CAYLAK_UNVERIFIED_SESSION_TOKEN",
};

/** The one name the logins live under: the Actions secret, the repository variable, and the env var. */
export const LOGINS_NAME = "PREVIEW_TEST_LOGINS";

type RawTokens = Partial<Readonly<Record<PreviewIdentity, Redacted.Redacted<string>>>>;

export type LoginBundleRead =
	| {readonly _tag: "Parsed"; readonly tokens: RawTokens}
	| {readonly _tag: "Malformed"; readonly reason: string};

/**
 * Read the bundle. Every `reason` is composed here and never quotes the input, not even a key: a
 * botched hand edit can put a token where a key belongs.
 */
export const parseLoginBundle = (raw: Redacted.Redacted<string>): LoginBundleRead => {
	const read = parseJson(Redacted.value(raw));
	if (read._tag === "Failed") return {_tag: "Malformed", reason: "it is not JSON"};
	const parsed = read.value;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {_tag: "Malformed", reason: "it is not a JSON object"};
	}
	const known = new Set(Object.values(IDENTITY_TOKEN_ENV));
	const entries = Object.entries(parsed);
	if (entries.some(([name]) => !known.has(name))) {
		return {
			_tag: "Malformed",
			reason: `it carries a key that is not one of ${[...known].join(", ")}`,
		};
	}
	const tokens: Partial<Record<PreviewIdentity, Redacted.Redacted<string>>> = {};
	for (const identity of PREVIEW_IDENTITIES) {
		const value = (parsed as Record<string, unknown>)[IDENTITY_TOKEN_ENV[identity]];
		if (value === undefined) continue;
		if (typeof value !== "string") {
			return {_tag: "Malformed", reason: `its ${IDENTITY_TOKEN_ENV[identity]} is not a string`};
		}
		tokens[identity] = Redacted.make(value);
	}
	return {_tag: "Parsed", tokens};
};

export type CredentialsRead =
	| {readonly _tag: "Resolved"; readonly credentials: PreviewCredentials}
	/** `source` names where the weak token was read, never the token. */
	| {readonly _tag: "Weak"; readonly source: string}
	| {readonly _tag: "MalformedBundle"; readonly reason: string};

/**
 * The tokens one run provisions. An identity's own variable wins over its bundle entry, so a hand
 * run can still seed one identity with a token of its choosing; an identity named by neither is
 * left out, which is how a run seeds fewer than all three.
 *
 * A malformed bundle refuses even when every identity has its own variable: a run handed a broken
 * value should hear about it rather than succeed past it.
 */
export const resolveCredentials = (
	own: RawTokens,
	bundle: Redacted.Redacted<string> | null,
): CredentialsRead => {
	const read = bundle === null ? null : parseLoginBundle(bundle);
	if (read?._tag === "Malformed") return {_tag: "MalformedBundle", reason: read.reason};
	const bundled = read?.tokens ?? {};
	const credentials: {-readonly [K in keyof PreviewCredentials]: PreviewCredentials[K]} = {};
	for (const identity of PREVIEW_IDENTITIES) {
		const variable = IDENTITY_TOKEN_ENV[identity];
		const [raw, source] =
			own[identity] !== undefined
				? [own[identity], `$${variable}`]
				: [bundled[identity], `$${LOGINS_NAME}'s ${variable}`];
		if (raw === undefined) continue;
		const token = parseSessionToken(raw);
		if (token === null) return {_tag: "Weak", source};
		credentials[identity] = token;
	}
	return {_tag: "Resolved", credentials};
};

const REDACTED = "<redacted>";

/** Replace every occurrence of a secret in `text`. An empty secret matches nothing. */
export const scrub = (text: string, secrets: readonly Redacted.Redacted<string>[]): string =>
	secrets.reduce((scrubbed, secret) => {
		const value = Redacted.value(secret);
		return value.length === 0 ? scrubbed : scrubbed.split(value).join(REDACTED);
	}, text);

/**
 * A failure's whole `cause` chain as one line, with the secrets scrubbed out. A database driver
 * reports a failed statement together with its bound parameters, and a session row's parameters
 * include its token, so the raw error must never reach a log.
 */
export const describeFailure = (
	cause: unknown,
	secrets: readonly Redacted.Redacted<string>[],
): string => {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = cause;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		parts.push(current instanceof Error ? current.message : String(current));
		current = current instanceof Error ? current.cause : undefined;
	}
	return scrub(parts.join(" — caused by: "), secrets);
};

/** 32 random bytes as base64url: 43 characters, none of them whitespace, `;` or `,`. */
const mintToken = (): string => Buffer.from(randomBytes(32)).toString("base64url");

/** A fresh bundle: one new token per identity, in the shape {@link parseLoginBundle} reads. */
export const mintLoginBundle = (mint: () => string = mintToken): Redacted.Redacted<string> =>
	Redacted.make(
		JSON.stringify(
			Object.fromEntries(
				PREVIEW_IDENTITIES.map((identity) => [IDENTITY_TOKEN_ENV[identity], mint()]),
			),
		),
	);

/** Where GitHub keeps one copy of the logins. */
export type LoginStore = "secret" | "variable";

export type StoreWrite =
	| {readonly _tag: "Written"}
	| {readonly _tag: "Refused"; readonly reason: string};

/** Write one copy. The bin's implementation hands the value to `gh` on stdin, never as an argument. */
export type WriteLogins = (
	store: LoginStore,
	value: Redacted.Redacted<string>,
) => Effect.Effect<StoreWrite>;

/**
 * Three arms, because the two half-done states are different facts. `SecretRefused` changed
 * nothing. `VariableRefused` left the secret new and the variable old, so previews are seeded with
 * tokens no agent can fetch until a re-run lands both.
 */
export type RotateOutcome =
	| {readonly _tag: "Rotated"; readonly identities: readonly PreviewIdentity[]}
	| {readonly _tag: "SecretRefused"; readonly reason: string}
	| {readonly _tag: "VariableRefused"; readonly reason: string};

/**
 * Mint one bundle and write it to both stores. This is the first set-up and the rotation alike: a
 * re-run replaces both copies. A preview already deployed keeps its old session rows until its next
 * deploy re-seeds it.
 */
export const rotateLogins = (
	write: WriteLogins,
	mint: () => Redacted.Redacted<string> = mintLoginBundle,
): Effect.Effect<RotateOutcome> =>
	Effect.gen(function* () {
		const bundle = mint();
		// The bundle and each token inside it: a tool that echoed either back must not reach the log.
		const minted = parseLoginBundle(bundle);
		const secrets = [bundle, ...(minted._tag === "Parsed" ? Object.values(minted.tokens) : [])];
		const secret = yield* write("secret", bundle);
		if (secret._tag === "Refused") {
			return {_tag: "SecretRefused", reason: scrub(secret.reason, secrets)};
		}
		const variable = yield* write("variable", bundle);
		if (variable._tag === "Refused") {
			return {_tag: "VariableRefused", reason: scrub(variable.reason, secrets)};
		}
		return {_tag: "Rotated", identities: PREVIEW_IDENTITIES};
	});
