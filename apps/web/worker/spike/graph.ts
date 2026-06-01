// SPIKE (throwaway): idiomatic static Effect-DI layer graph under deploy test.
//
// Brought over from branch `umut/spike-effect-di-graph` (commit 8959368), then
// adapted for the REAL deploy path: the STRUCTURAL STUB ambient services and the
// stub-backed `ManagedRuntime`/`bridgeSketch` from that branch are DROPPED here.
// In the real worker the ambient services (`RuntimeContext`, `Providers`,
// `WorkerEnvironment`, `D1ConnectionPolicy`) come from the actual alchemy worker
// scope (`worker/index.ts` init), not hand-built stubs — so this file exports
// ONLY the static layer definitions (`DrizzleLive`, `PasaportLive`, `AppLayer`).
// The `ManagedRuntime` is built in `worker/index.ts` from `AppLayer` using the
// captured real ambient context (see the SPIKE block there).
//
// Thesis under test: the worker's "function DI" (yield services to plain values
// in an imperative init block, thread them into `(deps) => Layer` factories) can
// be replaced by idiomatic Effect v4 DI — every layer declares its deps in its
// own `R` channel and `yield*`s Tags, composed into ONE static graph.
//
// The worst case is better-auth, because its `auth` field is a *deferred* effect
// `Effect<Auth, never, RuntimeContext>`. If that wires through pure Effect DI
// with honest types, the thesis holds a fortiori.
//
// HARD RULE: ZERO `as`/`as any`/`as unknown as` in this file.
//
// Q1 (plan-phase safety) lives HERE: `DrizzleLive` is a `Layer.effect` whose body
// pulls `connection.raw` EAGERLY (the same `Effect<D1Database, never,
// RuntimeContext>` runtime-only binding `BetterAuthLive` defers under
// `Effect.cached`). Whether building this layer fires `raw` at `alchemy deploy`
// PLAN time depends on WHEN the layer is built — see `worker/index.ts`.

import * as BetterAuth from "@alchemy.run/better-auth";
import type {RuntimeContext} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {createDrizzle, Drizzle, type DrizzleError, makeDrizzleAccess} from "../db/Drizzle.ts";
import {PhoenixDb} from "../db/resources.ts";
import {BetterAuthLive} from "../features/pasaport/better-auth-live.ts";
import {
	type Auth as BetterAuthInstance,
	type ContributionConnection,
	Pasaport,
	type ProfileRow,
	type Session,
	type SetUsernameResult,
	type UserRow,
} from "../features/pasaport/Pasaport.ts";
import {type Stats, StatsLive} from "../features/stats/Stats.ts";

/* ──────────────────────────────────────────────────────────────────────────
 * 1. DrizzleLive — `Layer.effect(Drizzle)` that yields the D1Connection Tag and
 *    binds `PhoenixDb`, then `connection.raw` EAGERLY, then `makeDrizzleAccess`.
 *
 *    This is the same shape `BetterAuthLive` ALREADY uses, EXCEPT BetterAuthLive
 *    defers its `connection.raw` pull under `Effect.cached`; DrizzleLive pulls it
 *    eagerly in the layer-build generator. That eager `raw` pull is exactly the
 *    runtime-only binding Q1 asks about — it is plan-safe ONLY if this layer is
 *    never BUILT at plan time.
 *
 *    Residual build-time `R` = `D1Connection | Providers | RuntimeContext`
 *    (`.bind` drags in `Providers`; `connection.raw` drags in `RuntimeContext`).
 *    The METHODS (`run`/`batch`) are `R = never` (closures over resolved `raw`).
 * ────────────────────────────────────────────────────────────────────────── */
export const DrizzleLive: Layer.Layer<
	Drizzle,
	never,
	Cloudflare.D1Connection | Cloudflare.Providers | RuntimeContext
> = Layer.effect(Drizzle)(
	Effect.gen(function* () {
		const connection = yield* Cloudflare.D1Connection.bind(PhoenixDb);
		const raw = yield* connection.raw;
		return makeDrizzleAccess(createDrizzle(raw));
	}),
);

/* ──────────────────────────────────────────────────────────────────────────
 * 2. PasaportLive — `Layer.effect(Pasaport)` that yields `Drizzle` AND the
 *    `BetterAuth.BetterAuth` Context tag, then `yield*`s better-auth's DEFERRED
 *    `auth` field to obtain the resolved `Auth` instance.
 *
 *    `yield* betterAuth.auth` pulls `RuntimeContext` into the LAYER's BUILD-TIME
 *    `R` (discharged once at graph assembly). It does NOT leak into each method's
 *    `R`, because the methods close over the already-resolved `auth` VALUE.
 *
 *    Residual build-time `R` = `Drizzle | BetterAuth.BetterAuth | RuntimeContext`.
 *
 *    NOTE: only `validateSession` is exercised by the spike route; the other
 *    methods keep honest signatures with stubbed bodies so `Pasaport.of` (the
 *    service-shape check) holds — proving the whole surface composes.
 * ────────────────────────────────────────────────────────────────────────── */
export const PasaportLive: Layer.Layer<
	Pasaport,
	never,
	Drizzle | BetterAuth.BetterAuth | RuntimeContext
> = Layer.effect(Pasaport)(
	Effect.gen(function* () {
		const {run} = yield* Drizzle;
		const betterAuth = yield* BetterAuth.BetterAuth;
		// The RuntimeContext-leak experiment: yielding the deferred `auth` here
		// resolves it to a plain `Auth` value.
		const auth: BetterAuthInstance = yield* betterAuth.auth;

		// `R = never` annotations are explicit so the compiler checks that yielding
		// `auth` above did NOT leak `RuntimeContext` into the method signatures.
		const validateSession = (headers: Headers): Effect.Effect<Session | null, never, never> =>
			Effect.tryPromise({
				try: async () => {
					const session = await auth.api.getSession({headers});
					if (!session?.user) return null;
					return session;
				},
				catch: (cause): {readonly _tag: "ValidateSessionError"; readonly cause: unknown} => ({
					_tag: "ValidateSessionError",
					cause,
				}),
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						console.error("[spike.validateSession]", error.cause);
						const out: Session | null = null;
						return out;
					}),
				),
			);

		const getUserById = (userId: string): Effect.Effect<UserRow | null, DrizzleError, never> =>
			Effect.gen(function* () {
				const row = yield* run((db) => db.query.user.findFirst());
				if (!row) return null;
				const out: UserRow = {
					id: row.id,
					email: row.email,
					name: row.name ?? null,
					image: row.image ?? null,
					username: row.username ?? null,
				};
				return out.id === userId ? out : out;
			});

		const notImplemented = Effect.die("spike: body omitted");
		const getUsersByIds = (
			_userIds: ReadonlyArray<string>,
		): Effect.Effect<UserRow[], DrizzleError, never> => notImplemented;
		const setUsername = (_input: {
			userId: string;
			value: string;
		}): Effect.Effect<SetUsernameResult, never, never> => notImplemented;
		const lookupProfile = (
			_username: string,
		): Effect.Effect<ProfileRow | null, DrizzleError, never> => notImplemented;
		const lookupProfileById = (
			_userId: string,
		): Effect.Effect<ProfileRow | null, DrizzleError, never> => notImplemented;
		const listContributions = (_input: {
			authorId: string;
			after: string | null;
			first: number;
		}): Effect.Effect<ContributionConnection, DrizzleError, never> => notImplemented;

		return {
			validateSession,
			getUserById,
			getUsersByIds,
			setUsername,
			lookupProfile,
			lookupProfileById,
			listContributions,
		};
	}),
);

/* ──────────────────────────────────────────────────────────────────────────
 * 3. AppLayer — compose DrizzleLive + PasaportLive + StatsLive, then
 *    `Layer.provide` the leaf layers `D1ConnectionLive` and the REAL
 *    `BetterAuthLive`.
 *
 *    Residual `R` of AppLayer (the alchemy-ambient services the leaf layers still
 *    demand): `RuntimeContext | Providers | WorkerEnvironment | D1ConnectionPolicy`.
 *    The REAL worker provides all four at its init scope (where these ambient
 *    services are live) via `Layer.succeedContext(capturedAmbient)`.
 * ────────────────────────────────────────────────────────────────────────── */
const Leaves = Layer.mergeAll(Cloudflare.D1ConnectionLive, BetterAuthLive);

export const AppLayer: Layer.Layer<
	Stats | Pasaport | Drizzle,
	never,
	| RuntimeContext
	| Cloudflare.Providers
	| Cloudflare.WorkerEnvironment
	| Cloudflare.D1ConnectionPolicy
> = Layer.mergeAll(StatsLive, PasaportLive).pipe(
	Layer.provideMerge(DrizzleLive),
	Layer.provide(Leaves),
);
