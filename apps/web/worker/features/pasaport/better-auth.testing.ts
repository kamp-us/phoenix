/**
 * Test stand-ins for the `BetterAuth` Context tag. The deployed worker satisfies
 * it with `BetterAuthLive`, which needs the full alchemy provider stack
 * (`RuntimeContext`, the `secret_text` binding) absent in the node test pool —
 * so these factories build a hand-rolled `BetterAuth` layer over the same tag.
 * `auth` is `Effect.succeed(...)` so its `R` is `never`.
 *
 * A **factory, not a shared instance** (`.patterns/effect-testing.md`).
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {type Auth, type BetterAuthOptions, betterAuth as makeBetterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer} from "better-auth/plugins";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as schema from "../../db/drizzle/schema.ts";

/**
 * A REAL better-auth instance over a test `D1Database` handle, reproducing
 * `BetterAuthLive`'s construction because that Layer needs the alchemy provider
 * stack the node test pool lacks.
 *
 * MUST stay in lockstep with `BetterAuthLive` (same `emailAndPassword`,
 * `drizzleAdapter`, `bearer()`, `additionalFields.username`) — if they drift the
 * guard suites silently test a different shape than production. Test-only diffs,
 * immaterial to the shape under test: literal `secret`/`baseURL`/`trustedOrigins`
 * and no `magicLink` plugin.
 *
 * Returns a concrete `Auth<{…}>`; callers widen to the generic `Auth` (see {@link layerTest}).
 */
export function makeRealAuthForTest(d1: D1Database) {
	const db = drizzle(d1, {relations: defineRelations(schema)});
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
 * A `BetterAuth` test layer over an already-constructed instance, wiring `auth`
 * (for `Pasaport`) and `fetch` (for `/api/auth/*`).
 *
 * Takes the generic `Auth`; `makeRealAuthForTest` returns a concrete `Auth<{…}>`
 * that doesn't statically overlap it (TS2345), so callers widen with a documented
 * `as unknown as Parameters<typeof layerTest>[0]` hop.
 */
export const layerTest = (instance: Auth): Layer.Layer<BetterAuth.BetterAuth> =>
	Layer.succeed(BetterAuth.BetterAuth)({
		auth: Effect.succeed(instance),
		fetch: Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const response = yield* Effect.promise(() => instance.handler(request.source as Request));
			return HttpServerResponse.fromWeb(response);
		}),
	});

/**
 * A fail-on-contact stub: `auth` is a canned no-op `getSession`, `fetch` is
 * `Effect.die` — for tests that never reach the session path or `/api/auth/*`.
 * A `layerStub` (fail-on-contact), not a `layerNoop` (which silently succeeds).
 */
export const layerStub = (): Layer.Layer<BetterAuth.BetterAuth> =>
	Layer.succeed(BetterAuth.BetterAuth)({
		// biome-ignore lint/plugin: better-auth's `Auth` instance type can't be partial-constructed; the bridge tests never reach the session path, so a `getSession` no-op stand-in suffices.
		auth: Effect.succeed({api: {getSession: async () => null}} as unknown as Auth),
		fetch: Effect.die("better-auth fetch not exercised in this test") as never,
	});
