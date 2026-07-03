/**
 * The keychain-first credentials resolver (#1730): `CredentialsKeychainFirst` satisfies the
 * SAME ambient `Credentials` requirement `CredentialsFromEnv` does (the seam
 * `FlagshipReadLive`/`FlagshipWriteLive` depend on), but resolves the API token from the
 * macOS Keychain first, falling back to `resolveFromEnv` (`$CLOUDFLARE_API_TOKEN`) when the
 * keychain has nothing — so `cf-utils auth login` works once for a human while CI's
 * env-var path is byte-for-byte unchanged. `AccountIdKeychainConfig` is the account-id
 * half: a `ConfigProvider` answering only `CLOUDFLARE_ACCOUNT_ID` keychain-first, so the
 * per-call `Config.string("CLOUDFLARE_ACCOUNT_ID")` reads inside `flagship.ts` pick it up
 * with zero handler changes.
 */
import {
	apiTokenCredentials,
	Credentials,
	type CredentialsError,
	type ResolvedCredentials,
	resolveFromEnv,
} from "@distilled.cloud/cloudflare/Credentials";
import {ConfigError} from "@distilled.cloud/cloudflare/Errors";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import {ConfigProvider, Data, Effect, Layer, Stream} from "effect";
import type {HttpClient} from "effect/unstable/http/HttpClient";
import {ACCOUNT_ID_ACCOUNT, API_TOKEN_ACCOUNT, Keychain} from "./keychain.ts";

const LOGIN_HINT =
	"run `cf-utils auth login` to store credentials in the keychain, or export $CLOUDFLARE_API_TOKEN / $CLOUDFLARE_ACCOUNT_ID";

const resolveKeychainFirst: Effect.Effect<ResolvedCredentials, CredentialsError, Keychain> =
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

export const CredentialsKeychainFirst: Layer.Layer<Credentials, never, Keychain> = Layer.effect(
	Credentials,
)(
	Effect.gen(function* () {
		const keychain = yield* Keychain;
		// Cached: the token can't expire mid-run, and caching keeps repeated ops (e.g. the
		// per-app reads inside `listFlagStates`) from re-spawning `security` per call.
		return yield* Effect.cached(Effect.provideService(resolveKeychainFirst, Keychain, keychain));
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

/** Where a credential resolved from — the fact `auth status` reports per credential. */
export type CredentialSource = "keychain" | "env" | "missing";

export interface CredentialSources {
	readonly apiToken: CredentialSource;
	readonly accountId: {readonly source: CredentialSource; readonly value: string | undefined};
}

/** Resolve, without failing, where the token and account id would come from right now. */
export const credentialSources: Effect.Effect<CredentialSources, never, Keychain> = Effect.gen(
	function* () {
		const keychain = yield* Keychain;
		const [storedToken, storedAccount] = yield* Effect.all([
			keychain.get(API_TOKEN_ACCOUNT),
			keychain.get(ACCOUNT_ID_ACCOUNT),
		]);
		const envToken = process.env.CLOUDFLARE_API_TOKEN;
		const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
		const apiToken: CredentialSource =
			storedToken !== undefined ? "keychain" : envToken !== undefined ? "env" : "missing";
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
