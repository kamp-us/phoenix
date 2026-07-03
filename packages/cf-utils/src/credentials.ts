/**
 * The keychain-first credentials resolver (#1730, extended for OAuth in #1761):
 * `CredentialsKeychainFirst` satisfies the SAME ambient `Credentials` requirement
 * `CredentialsFromEnv` does (the seam `FlagshipReadLive`/`FlagshipWriteLive` depend on), but
 * resolves the credential from the macOS Keychain first, falling back to `resolveFromEnv`
 * (`$CLOUDFLARE_API_TOKEN`) when the keychain has nothing — so `cf-utils auth login` works
 * once for a human while CI's env-var path is byte-for-byte unchanged.
 *
 * Resolution precedence (keychain): OAuth token set → pasted API token → env fallback. The
 * OAuth set is an EXPIRING access token + refresh token (#1761's browser flow), so it resolves
 * through the SDK's `fromOAuth` provider, which refreshes the access token on/near expiry; the
 * provider's `refresh` PERSISTS the fresh tokens back to the keychain so a later invocation
 * starts from the renewed set. A pasted API token (token-paste path) is long-lived and needs no
 * refresh, so its resolution is unchanged.
 *
 * `AccountIdKeychainConfig` is the account-id half: a `ConfigProvider` answering only
 * `CLOUDFLARE_ACCOUNT_ID` keychain-first, so the per-call `Config.string("CLOUDFLARE_ACCOUNT_ID")`
 * reads inside `flagship.ts` pick it up with zero handler changes.
 */
import {
	apiTokenCredentials,
	Credentials,
	type CredentialsError,
	fromOAuth,
	type OAuthConfig,
	type OAuthProvider,
	type ResolvedCredentials,
	resolveFromEnv,
} from "@distilled.cloud/cloudflare/Credentials";
import {ConfigError} from "@distilled.cloud/cloudflare/Errors";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import {ConfigProvider, Data, Effect, Layer, Stream} from "effect";
import type {HttpClient} from "effect/unstable/http/HttpClient";
import {
	ACCOUNT_ID_ACCOUNT,
	API_TOKEN_ACCOUNT,
	Keychain,
	type KeychainCommandError,
	type KeychainService,
	OAUTH_ACCESS_TOKEN_ACCOUNT,
	OAUTH_EXPIRES_AT_ACCOUNT,
	OAUTH_REFRESH_TOKEN_ACCOUNT,
} from "./keychain.ts";
import {type OAuthTokens, refresh as refreshTokens} from "./oauth.ts";

const LOGIN_HINT =
	"run `cf-utils auth login` to store credentials in the keychain, or export $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID";

/** Read a complete OAuth token set from the keychain, or `undefined` if any part is missing. */
export const readOAuthTokens = (
	keychain: KeychainService,
): Effect.Effect<OAuthTokens | undefined> =>
	Effect.gen(function* () {
		const [accessToken, refreshToken, expiresAtRaw] = yield* Effect.all([
			keychain.get(OAUTH_ACCESS_TOKEN_ACCOUNT),
			keychain.get(OAUTH_REFRESH_TOKEN_ACCOUNT),
			keychain.get(OAUTH_EXPIRES_AT_ACCOUNT),
		]);
		if (accessToken === undefined || refreshToken === undefined) {
			return undefined;
		}
		const expiresAt = expiresAtRaw === undefined ? Number.NaN : Number(expiresAtRaw);
		return {
			accessToken,
			refreshToken,
			expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
			scopes: [],
		};
	});

/** Persist an OAuth token set (access + refresh + expiry) back through the keychain seam. */
export const writeOAuthTokens = (
	keychain: KeychainService,
	tokens: OAuthTokens,
): Effect.Effect<void, KeychainCommandError> =>
	Effect.all(
		[
			keychain.set(OAUTH_ACCESS_TOKEN_ACCOUNT, tokens.accessToken),
			keychain.set(OAUTH_REFRESH_TOKEN_ACCOUNT, tokens.refreshToken),
			keychain.set(OAUTH_EXPIRES_AT_ACCOUNT, String(tokens.expiresAt)),
		],
		{discard: true},
	);

/**
 * A keychain-backed `OAuthProvider` for the SDK's `fromOAuth`: `load` reads the stored set,
 * `refresh` exchanges the refresh token AND writes the fresh set back to the keychain (so the
 * renewed access/refresh/expiry survive to the next invocation). A failed refresh persists
 * nothing and surfaces as the SDK's `OAuthRefreshError`.
 */
const keychainOAuthProvider = (keychain: KeychainService, initial: OAuthTokens): OAuthProvider => ({
	load: Effect.succeed<OAuthConfig>({
		accessToken: initial.accessToken,
		refreshToken: initial.refreshToken,
		expiresAt: initial.expiresAt,
	}),
	refresh: (credentials) =>
		Effect.gen(function* () {
			const next = yield* refreshTokens(credentials.refreshToken ?? initial.refreshToken);
			yield* writeOAuthTokens(keychain, next).pipe(Effect.ignore);
			return {
				accessToken: next.accessToken,
				refreshToken: next.refreshToken,
				expiresAt: next.expiresAt,
			} satisfies OAuthConfig;
		}),
});

const resolveTokenOrEnv: Effect.Effect<ResolvedCredentials, CredentialsError, Keychain> =
	Effect.gen(function* () {
		const keychain = yield* Keychain;
		const stored = yield* keychain.get(API_TOKEN_ACCOUNT);
		if (stored !== undefined) {
			return apiTokenCredentials({apiToken: stored});
		}
		return yield* resolveFromEnv.pipe(
			Effect.mapError((error) => new ConfigError({message: `${error.message} — ${LOGIN_HINT}`})),
		);
	});

export const CredentialsKeychainFirst: Layer.Layer<Credentials, never, Keychain> = Layer.unwrap(
	Effect.gen(function* () {
		const keychain = yield* Keychain;
		const oauth = yield* readOAuthTokens(keychain);
		// OAuth set present ⇒ resolve through the SDK's `fromOAuth` (it caches + refreshes on
		// expiry, persisting the renewed set via the provider's `refresh`). Otherwise fall back
		// to the token-paste/env resolution, cached (the pasted/env token can't expire mid-run,
		// and caching keeps `listFlagStates`'s per-app reads from re-spawning `security`).
		if (oauth !== undefined) {
			return fromOAuth(keychainOAuthProvider(keychain, oauth));
		}
		const cached = yield* Effect.cached(
			Effect.provideService(resolveTokenOrEnv, Keychain, keychain),
		);
		return Layer.succeed(Credentials)(cached);
	}),
);

/**
 * Installs a `ConfigProvider` that resolves `CLOUDFLARE_ACCOUNT_ID` from the keychain
 * first and delegates every other path (and a keychain miss) to the ambient provider
 * (default: the env) — the account-id twin of `CredentialsKeychainFirst`.
 */
export const AccountIdKeychainConfig: Layer.Layer<never, never, Keychain> = ConfigProvider.layer(
	Effect.gen(function* () {
		const keychain = yield* Keychain;
		const ambient = yield* ConfigProvider.ConfigProvider;
		const cached = yield* Effect.cached(keychain.get(ACCOUNT_ID_ACCOUNT));
		const fromKeychain = ConfigProvider.make((path) =>
			path.length === 1 && path[0] === "CLOUDFLARE_ACCOUNT_ID"
				? Effect.map(cached, (value) =>
						value === undefined ? undefined : ConfigProvider.makeValue(value),
					)
				: Effect.succeed(undefined),
		);
		return ConfigProvider.orElse(fromKeychain, ambient);
	}),
);

/**
 * Where a credential resolved from — the fact `auth status` reports per credential. `oauth`
 * (#1761) is the keychain-stored OAuth token set; it extends the existing `keychain | env |
 * missing` model without changing what those three mean (a token-paste keychain hit still
 * reports `keychain`, the env-var CI path still reports `env`).
 */
export type CredentialSource = "oauth" | "keychain" | "env" | "missing";

export interface CredentialSources {
	readonly apiToken: CredentialSource;
	readonly accountId: {readonly source: CredentialSource; readonly value: string | undefined};
}

/** Resolve, without failing, where the token and account id would come from right now. */
export const credentialSources: Effect.Effect<CredentialSources, never, Keychain> = Effect.gen(
	function* () {
		const keychain = yield* Keychain;
		const [oauthTokens, storedToken, storedAccount] = yield* Effect.all([
			readOAuthTokens(keychain),
			keychain.get(API_TOKEN_ACCOUNT),
			keychain.get(ACCOUNT_ID_ACCOUNT),
		]);
		const envToken = process.env.CLOUDFLARE_API_TOKEN;
		const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
		// Same precedence as resolution: OAuth (keychain) → pasted token (keychain) → env → missing.
		const apiToken: CredentialSource =
			oauthTokens !== undefined
				? "oauth"
				: storedToken !== undefined
					? "keychain"
					: envToken !== undefined
						? "env"
						: "missing";
		const accountId =
			storedAccount !== undefined
				? {source: "keychain" as const, value: storedAccount}
				: envAccount !== undefined
					? {source: "env" as const, value: envAccount}
					: {source: "missing" as const, value: undefined};
		return {apiToken, accountId};
	},
);

/** The pasted credentials failed the pre-persist validating read. Nothing was stored. */
export class CredentialValidationFailed extends Data.TaggedError("CredentialValidationFailed")<{
	readonly reason: string;
}> {
	override get message(): string {
		return `credential validation failed — nothing was stored: ${this.reason}`;
	}
}

/**
 * The cheap authenticated read `auth login` runs BEFORE persisting: `listApps` under a
 * `Credentials` service built from exactly the pasted token + account id (never the
 * ambient resolution, which would mask a bad paste with a working env var). Succeeds with
 * the number of visible Flagship apps.
 */
export const validateCredentials = (
	apiToken: string,
	accountId: string,
): Effect.Effect<number, CredentialValidationFailed, HttpClient> =>
	Stream.runCollect(flagship.listApps.items({accountId})).pipe(
		Effect.map((apps) => apps.length),
		Effect.provideService(Credentials, Effect.succeed(apiTokenCredentials({apiToken}))),
		Effect.mapError(
			(cause) =>
				new CredentialValidationFailed({
					reason: cause instanceof Error ? cause.message : String(cause),
				}),
		),
	);
