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
import {
	decodeEnv,
	decodeFlagState,
	type FlagState,
	planNextState,
	type RawFlag,
	type ServeTarget,
} from "./flag.ts";

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
	readonly rules: ReadonlyArray<{
		readonly conditions: ReadonlyArray<unknown>;
		readonly priority: number;
		readonly serveVariation: string;
		readonly rollout?: {readonly percentage: number; readonly attribute?: string | null} | null;
	}>;
}): RawFlag => ({
	key: flag.key,
	enabled: flag.enabled,
	defaultVariation: flag.defaultVariation,
	variations: flag.variations,
	// Conditions stay opaque — the pure core only tests their presence and round-trips them verbatim.
	rules: flag.rules,
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
 * `FlagshipWrite` — the injectable release seam. `setServing` is the ONE mutation `cf-utils`
 * performs: it reads the flag's current full envelope (so an unknown key fails
 * `FlagshipFlagNotFound` BEFORE any write), computes the next serving state with the pure
 * core (`planNextState` — the no-match split is the release lever, #1726), and re-writes the
 * envelope. `Percent` moves only the split rule (`defaultVariation` keeps its create-time
 * safe value); `Kill` clears the split AND sets `defaultVariation` off — the true kill
 * switch. `enabled`, `variations`, and targeting rules pass through unchanged (#1609). No
 * new transport: it rides the same ambient `Credentials | HttpClient` as `FlagshipReadLive`.
 */
export class FlagshipWrite extends Context.Service<
	FlagshipWrite,
	{
		readonly setServing: (input: {
			readonly appId: string;
			readonly flagKey: string;
			readonly target: ServeTarget;
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

			const setServing = (input: {
				readonly appId: string;
				readonly flagKey: string;
				readonly target: ServeTarget;
			}) =>
				withCtx(
					Effect.gen(function* () {
						const acct = yield* accountId;
						// Read-before-write: fail not-found on an unknown key BEFORE mutating, and carry the
						// current envelope forward so only the serving state (split rule / kill) moves.
						const current = yield* flagship.getAppFlag({
							appId: input.appId,
							flagKey: input.flagKey,
							accountId: acct,
						});
						const next = planNextState(toRawFlag(current), input.target);
						const updated = yield* flagship.updateAppFlag({
							appId: input.appId,
							flagKey: input.flagKey,
							accountId: acct,
							key: current.key,
							enabled: current.enabled,
							defaultVariation: next.defaultVariation,
							variations: current.variations,
							// Rule conditions round-trip verbatim (#1609); the Get and Update rule shapes differ
							// only in a nullable `rollout.attribute`, structurally identical for the cast.
							rules: next.rules as flagship.UpdateAppFlagRequest["rules"],
						});
						return toRawFlag(updated);
					}),
				);

			return {setServing};
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
							// An owned-but-inaccessible app (orphaned / mid-deletion per-PR-preview app —
							// a steady-state condition, #813/#690/#1509) fails this fetch with
							// `FlagshipAppNotFound` (the SDK's tag for the 404 "App not found or access
							// denied" ownership error). Skip it with a warning so the enumeration degrades
							// to "every accessible app" instead of aborting the whole listing (#1645). The
							// catch is scoped to that ONE tag: a transport/auth `Unauthorized` or any other
							// `DefaultErrors`/`ConfigError` still fails loud, never swallowed as a skip.
							const flags = yield* Stream.runCollect(
								flagship.listAppFlags.items({appId: app.id, accountId: acct}),
							).pipe(
								Effect.catchTag("FlagshipAppNotFound", (error) =>
									Effect.logWarning(
										`skipping inaccessible Flagship app "${app.name}" (${app.id}) in env "${env}": ${error.message}`,
									).pipe(Effect.as([] as ReadonlyArray<never>)),
								),
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
