/**
 * The Flagship read client — the load-bearing seam every later `cf-utils` slice reuses. A
 * typed Effect service wrapping `@distilled.cloud/cloudflare`'s canonical flagship read
 * operations (`listApps`, `listAppFlags`, `getAppFlag`) — the SAME transport
 * `@kampus/d1-rest` runs D1 over (already in the tree via alchemy), so this rolls NO new
 * raw-`curl` client (the third-copy bug class, #941). Schema decoding + typed errors
 * (`FlagshipAppNotFound`/`FlagshipFlagNotFound`, `Unauthorized`, …) come from the SDK; they
 * ride the `E` channel so an unreachable/unauthorized CF surfaces a typed error, never a
 * stack trace.
 *
 * Credentials come from the environment at runtime, NEVER from source: the ambient
 * `Credentials | HttpClient` (`CredentialsFromEnv` reads `$CLOUDFLARE_API_TOKEN`,
 * `FetchHttpClient.layer` the transport) is captured at layer build and re-provided into
 * each op; `$CLOUDFLARE_ACCOUNT_ID` is read per call via `Config`.
 *
 * `listFlagStates` is the enumeration `flag list` prints: it lists every Flagship app,
 * decodes each app's stage as its `env` (`decodeEnv`, skipping foreign apps), lists that
 * app's flags, and reduces each to a `key × env` row (`decodeFlagState`).
 */
import type {Credentials} from "@distilled.cloud/cloudflare/Credentials";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import {Config, Context, Effect, Layer, Stream} from "effect";
import type {HttpClient} from "effect/unstable/http/HttpClient";
import {decodeEnv, decodeFlagState, type FlagState, type RawFlag} from "./flag.ts";

export {FlagshipAppNotFound, FlagshipFlagNotFound} from "@distilled.cloud/cloudflare/flagship";

/** A Flagship app reduced to the identity the client keys on: `id` is the API key, `name` the stage-bearer. */
export interface FlagshipApp {
	readonly id: string;
	readonly name: string;
}

/**
 * The read client's error channel: every typed fault the wrapped SDK ops surface
 * (transport/auth `DefaultErrors` + `FlagshipAppNotFound`/`FlagshipFlagNotFound`) plus the
 * `ConfigError` from resolving `$CLOUDFLARE_ACCOUNT_ID`. All typed, all in `E` — no throw.
 */
export type FlagshipReadError =
	| flagship.ListAppsError
	| flagship.ListAppFlagsError
	| flagship.GetAppFlagError
	| Config.ConfigError;

const toRawFlag = (flag: {
	readonly key: string;
	readonly enabled: boolean;
	readonly defaultVariation: string;
	readonly variations: Record<string, unknown>;
}): RawFlag => ({
	key: flag.key,
	enabled: flag.enabled,
	defaultVariation: flag.defaultVariation,
	variations: flag.variations,
});

/**
 * `FlagshipRead` — the injectable read seam. `listApps`/`listAppFlags`/`getAppFlag` are the
 * thin wrappers over the SDK ops; `listFlagStates` is the `env`-decoding enumeration the bin
 * renders. Built by `FlagshipReadLive`, whose `R` is the ambient `Credentials | HttpClient`.
 */
export class FlagshipRead extends Context.Service<
	FlagshipRead,
	{
		readonly listApps: () => Effect.Effect<ReadonlyArray<FlagshipApp>, FlagshipReadError>;
		readonly listAppFlags: (
			appId: string,
		) => Effect.Effect<ReadonlyArray<RawFlag>, FlagshipReadError>;
		readonly getAppFlag: (
			appId: string,
			flagKey: string,
		) => Effect.Effect<RawFlag, FlagshipReadError>;
		readonly listFlagStates: () => Effect.Effect<ReadonlyArray<FlagState>, FlagshipReadError>;
	}
>()("@kampus/cf-utils/FlagshipRead") {}

const accountId = Config.string("CLOUDFLARE_ACCOUNT_ID");

/**
 * The write client's error channel: the `updateAppFlag`/`getAppFlag` typed faults
 * (transport/auth + `FlagshipFlagNotFound`/`FlagshipAppNotFound`) plus the `ConfigError`
 * from resolving `$CLOUDFLARE_ACCOUNT_ID`. All typed, all in `E`.
 */
export type FlagshipWriteError =
	| flagship.GetAppFlagError
	| flagship.UpdateAppFlagError
	| Config.ConfigError;

/**
 * `FlagshipWrite` — the injectable flip seam. `setFlagDefault` is the ONE mutation `cf-utils`
 * performs: it reads the flag's current full envelope (so an unknown key fails
 * `FlagshipFlagNotFound` BEFORE any write), then re-writes it with only `defaultVariation`
 * moved to the target `{off,on}` variation — `enabled`, `rules`, and `variations` pass
 * through unchanged (targeting-rule edits are out of scope, #1609). No new transport: it
 * rides the same ambient `Credentials | HttpClient` as `FlagshipReadLive`.
 */
export class FlagshipWrite extends Context.Service<
	FlagshipWrite,
	{
		readonly setFlagDefault: (input: {
			readonly appId: string;
			readonly flagKey: string;
			readonly targetVariation: string;
		}) => Effect.Effect<RawFlag, FlagshipWriteError>;
	}
>()("@kampus/cf-utils/FlagshipWrite") {}

export const FlagshipWriteLive: Layer.Layer<FlagshipWrite, never, Credentials | HttpClient> =
	Layer.effect(FlagshipWrite)(
		Effect.gen(function* () {
			const context = yield* Effect.context<Credentials | HttpClient>();
			const withCtx = <A, E>(
				effect: Effect.Effect<A, E, Credentials | HttpClient>,
			): Effect.Effect<A, E> => Effect.provide(effect, context);

			const setFlagDefault = (input: {
				readonly appId: string;
				readonly flagKey: string;
				readonly targetVariation: string;
			}) =>
				withCtx(
					Effect.gen(function* () {
						const acct = yield* accountId;
						// Read-before-write: fail not-found on an unknown key BEFORE mutating, and carry the
						// current envelope forward so only defaultVariation moves.
						const current = yield* flagship.getAppFlag({
							appId: input.appId,
							flagKey: input.flagKey,
							accountId: acct,
						});
						const updated = yield* flagship.updateAppFlag({
							appId: input.appId,
							flagKey: input.flagKey,
							accountId: acct,
							key: current.key,
							enabled: current.enabled,
							defaultVariation: input.targetVariation,
							variations: current.variations,
							// Rules pass through opaquely — this slice flips only the served value; the Get and
							// Update rule shapes differ only in a nullable `rollout.attribute`, structurally
							// identical for a verbatim round-trip.
							rules: current.rules as flagship.UpdateAppFlagRequest["rules"],
						});
						return toRawFlag(updated);
					}),
				);

			return {setFlagDefault};
		}),
	);

export const FlagshipReadLive: Layer.Layer<FlagshipRead, never, Credentials | HttpClient> =
	Layer.effect(FlagshipRead)(
		Effect.gen(function* () {
			// Capture the ambient transport/credentials ONCE, re-provide into each op so the
			// public methods carry `R = never` (the same shape orphan-sweep's CloudflareLive uses).
			const context = yield* Effect.context<Credentials | HttpClient>();
			const withCtx = <A, E>(
				effect: Effect.Effect<A, E, Credentials | HttpClient>,
			): Effect.Effect<A, E> => Effect.provide(effect, context);

			const listApps = () =>
				withCtx(
					Effect.gen(function* () {
						const acct = yield* accountId;
						const items = yield* Stream.runCollect(flagship.listApps.items({accountId: acct}));
						return items.map((app): FlagshipApp => ({id: app.id, name: app.name}));
					}),
				);

			const listAppFlags = (appId: string) =>
				withCtx(
					Effect.gen(function* () {
						const acct = yield* accountId;
						const items = yield* Stream.runCollect(
							flagship.listAppFlags.items({appId, accountId: acct}),
						);
						return items.map(toRawFlag);
					}),
				);

			const getAppFlag = (appId: string, flagKey: string) =>
				withCtx(
					Effect.gen(function* () {
						const acct = yield* accountId;
						const flag = yield* flagship.getAppFlag({appId, flagKey, accountId: acct});
						return toRawFlag(flag);
					}),
				);

			const listFlagStates = () =>
				withCtx(
					Effect.gen(function* () {
						const acct = yield* accountId;
						const apps = yield* Stream.runCollect(flagship.listApps.items({accountId: acct}));
						const rows: Array<FlagState> = [];
						for (const app of apps) {
							const env = decodeEnv(app.name);
							if (env === undefined) {
								continue; // a foreign account app — not one of ours, no env to decode
							}
							const flags = yield* Stream.runCollect(
								flagship.listAppFlags.items({appId: app.id, accountId: acct}),
							);
							for (const flag of flags) {
								rows.push(decodeFlagState(env, toRawFlag(flag)));
							}
						}
						return rows;
					}),
				);

			return {listApps, listAppFlags, getAppFlag, listFlagStates};
		}),
	);
