/**
 * Test stand-ins for the `BetterAuth` Context tag (`@alchemy.run/better-auth`).
 *
 * `makeFateLayer` (ADR 0040 b1) is a zero-arg layer with `R = Database |
 * BetterAuth`: a test provides one `Database` layer and one `BetterAuth` layer
 * and both `Drizzle` and `Pasaport`'s auth derive from them. The deployed worker
 * satisfies `BetterAuth` with `BetterAuthLive` (which needs the full alchemy
 * provider stack — `RuntimeContext`, the `secret_text` binding — absent in the
 * node test pool). These factories build a hand-rolled `BetterAuth` layer over
 * the same Context tag so tests thread it through `makeFateLayer` / `makeAppLive`
 * exactly as the worker does.
 *
 * `auth` is an `Effect.succeed(...)` (so its `R` is `never` — no `RuntimeContext`
 * surfaces through `makeFateLayer`'s `PasaportFromTag`).
 *
 * A **factory, not a shared instance** (`.patterns/effect-testing.md`).
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {type Auth, type BetterAuthOptions, betterAuth as makeBetterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer} from "better-auth/plugins";
import {drizzle} from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as schema from "../../db/drizzle/schema.ts";

/**
 * Build a REAL better-auth instance over a test `D1Database` handle (the
 * `node:sqlite`-backed `SqliteD1.d1`), mirroring the deployed `BetterAuthLive`
 * (`worker/features/pasaport/better-auth-live.ts`) — the canonical config.
 *
 * MUST be kept in lockstep with `BetterAuthLive`: same `emailAndPassword`,
 * `drizzleAdapter(..., {provider: "sqlite", schema})`, `bearer()` plugin, and the
 * `user.additionalFields.username` field. The deployed worker assembles its auth
 * via `BetterAuthLive`, but that Layer needs the full alchemy provider stack
 * (`RuntimeContext`, the `secret_text` binding) which the node test pool lacks —
 * so the construction is reproduced directly here. If this and `BetterAuthLive`
 * drift, the guard suites silently test a different shape than production.
 *
 * Differences from `BetterAuthLive`, all test-only and immaterial to the shape
 * under test: an explicit literal `secret`/`baseURL`/`trustedOrigins` (the Layer
 * derives these from config/`ENVIRONMENT`), and the `magicLink` plugin is
 * dropped (no test exercises token delivery).
 *
 * Returns the concrete `Auth<{…}>` from `makeBetterAuth`; callers widen it to the
 * generic `Auth` that {@link makeBetterAuthTestLayer} takes (see its note).
 */
export function makeRealAuthForTest(d1: D1Database) {
	const db = drizzle(d1, {schema});
	return makeBetterAuth({
		emailAndPassword: {enabled: true},
		database: drizzleAdapter(db, {provider: "sqlite", schema}),
		secret: "phoenix-test-secret",
		baseURL: "http://localhost:3000",
		trustedOrigins: ["http://localhost:3000"],
		user: {
			additionalFields: {
				username: {type: "string", required: false, input: false},
			},
		},
		plugins: [bearer()],
	} satisfies BetterAuthOptions);
}

/**
 * A `BetterAuth` layer wrapping an already-constructed better-auth instance —
 * `app.test.ts` builds a real one (via {@link makeRealAuthForTest}) over its
 * `node:sqlite` D1 and wires both the `auth` field (for `Pasaport`) and a `fetch`
 * that delegates to the instance's `handler` (for the `/api/auth/*` route).
 *
 * The parameter is the generic `Auth`; `makeRealAuthForTest` returns a concrete
 * `Auth<{…}>` that doesn't statically overlap it (TS2345), so callers widen with
 * a documented `as unknown as Parameters<typeof makeBetterAuthTestLayer>[0]` hop.
 */
export const makeBetterAuthTestLayer = (instance: Auth): Layer.Layer<BetterAuth.BetterAuth> =>
	Layer.succeed(BetterAuth.BetterAuth)({
		auth: Effect.succeed(instance),
		fetch: Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const response = yield* Effect.promise(() => instance.handler(request.source as Request));
			return HttpServerResponse.fromWeb(response);
		}),
	});

/**
 * A stub `BetterAuth` layer whose `auth` is a no-op `getSession` instance — for
 * tests that never reach the session path (`Pasaport.validateSession`) and never
 * hit `/api/auth/*` (so `fetch` dies if reached). The bridge tests use this.
 */
export const makeStubBetterAuthLayer = (): Layer.Layer<BetterAuth.BetterAuth> =>
	Layer.succeed(BetterAuth.BetterAuth)({
		// biome-ignore lint/plugin: better-auth's `Auth` instance type can't be partial-constructed; the bridge tests never reach the session path, so a `getSession` no-op stand-in suffices.
		auth: Effect.succeed({api: {getSession: async () => null}} as unknown as Auth),
		fetch: Effect.die("better-auth fetch not exercised in this test") as never,
	});
