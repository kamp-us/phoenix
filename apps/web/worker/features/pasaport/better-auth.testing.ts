/**
 * Test stand-ins for the `BetterAuth` Context tag. `BetterAuthLive` needs the full alchemy
 * provider stack (`RuntimeContext`, the `secret_text` binding) the node test pool lacks, so these
 * factories build a hand-rolled layer over the same tag. Factories, not shared instances
 * (`.patterns/effect-testing.md`).
 */
import * as BetterAuth from "@alchemy.run/better-auth";
import {apiKey} from "@better-auth/api-key";
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
import {apiKeyRateLimit, BetterAuthHandlerError} from "./better-auth-live.ts";

/**
 * A REAL better-auth instance over a test `D1Database` handle. MUST stay in lockstep with
 * `BetterAuthLive` (same `emailAndPassword`, `drizzleAdapter`, `bearer()`, `apiKey()`,
 * `additionalFields.username`) — drift means the guard suites silently test a shape production
 * never runs. Deliberate test-only diffs: literal `secret`/`baseURL`/`trustedOrigins`, no
 * `magicLink` plugin.
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
		plugins: [bearer(), apiKey({rateLimit: apiKeyRateLimit, enableSessionForAPIKeys: true})],
	} satisfies BetterAuthOptions);
}

/**
 * A `BetterAuth` test layer over an already-constructed instance. It takes the generic `Auth`,
 * which `makeRealAuthForTest`'s concrete `Auth<{…}>` does not statically overlap (TS2345) — hence
 * the `as unknown as Parameters<typeof layerTest>[0]` hop at the call sites.
 */
export const layerTest = (instance: Auth): Layer.Layer<BetterAuth.BetterAuth> =>
	Layer.succeed(BetterAuth.BetterAuth)({
		auth: Effect.succeed(instance),
		fetch: Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const response = yield* Effect.tryPromise({
				try: () => instance.handler(request.source as Request),
				catch: (cause) => new BetterAuthHandlerError({cause}),
			}).pipe(Effect.orDie);
			return HttpServerResponse.fromWeb(response);
		}),
	});

/**
 * A fail-on-contact stub (not a `layerNoop`, which would silently succeed) — for tests that never
 * reach the session path or `/api/auth/*`.
 */
export const layerStub = (): Layer.Layer<BetterAuth.BetterAuth> =>
	Layer.succeed(BetterAuth.BetterAuth)({
		// biome-ignore lint/plugin: better-auth's `Auth` instance type can't be partial-constructed; the bridge tests never reach the session path, so a `getSession` no-op stand-in suffices.
		auth: Effect.succeed({api: {getSession: async () => null}} as unknown as Auth),
		fetch: Effect.die("better-auth fetch not exercised in this test") as never,
	});
