/**
 * Phoenix's `BetterAuth` Layer — a fork of `@alchemy.run/better-auth`'s
 * `CloudflareD1` reference Layer, adapted for phoenix's existing infrastructure.
 *
 * Why fork instead of reuse `CloudflareD1`:
 *
 *   - `CloudflareD1` declares its OWN `Cloudflare.D1Database("BetterAuth")` —
 *     phoenix already has the canonical `PhoenixDb` D1 (`db/resources.ts`,
 *     ADR 0009), and the better-auth tables live on the same D1 as the rest of
 *     the product data. So this Layer reuses `PhoenixDb` directly.
 *   - Phoenix's better-auth instance needs phoenix-specific plugins (the
 *     `magicLink` token-delivery plugin, `bearer`), an `additionalFields.username`
 *     on `user`, and explicit `baseURL`/`trustedOrigins` for the dev Vite proxy
 *     (ADR 0031). The reference Layer is minimal by design — this fork carries
 *     phoenix's configuration.
 *
 * The session-signing secret is minted by `alchemy/Random` and persisted in
 * alchemy state, so re-deploys keep the same secret unless the resource is
 * replaced. This replaces the previous `BETTER_AUTH_SECRET` env-binding path
 * (`Redacted.make(deployEnv.BETTER_AUTH_SECRET)` in the worker `env` block) —
 * no more deploy-time env wiring for the secret.
 */

import * as BetterAuth from "@alchemy.run/better-auth";
// Re-anchor transitive type specifiers away from `.pnpm/<hash>/...` paths so
// tsgo can portably name plugin types under composite project refs.
// See microsoft/typescript-go#1034 and better-auth#5666 for context.
import type {} from "@better-auth/core";
import {Random} from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import {type BetterAuthOptions, betterAuth as makeBetterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer, magicLink} from "better-auth/plugins";
import type {} from "better-call";
import {drizzle} from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {} from "zod/v4/core";
import * as schema from "../../db/drizzle/schema.ts";
import {PhoenixDb} from "../../db/resources.ts";

/**
 * The phoenix `BetterAuth` Layer — fork of `@alchemy.run/better-auth`'s
 * `CloudflareD1` reference Layer. Mirrors its structure (`Random` for the
 * secret, `Cloudflare.D1Connection.bind` for the database, `Effect.cached` so
 * the `makeBetterAuth` call happens once per isolate) and adds phoenix's
 * plugins + `baseURL`/`trustedOrigins`.
 *
 * `baseURL`/`trustedOrigins` are derived from `ENVIRONMENT` (read off the
 * `WorkerEnvironment` Tag at layer build): in dev they are set explicitly to
 * `localhost` so cookie storage works behind the Vite proxy (where the worker
 * sees `Host: 127.0.0.1:<port>` rather than the browser origin); in prod they
 * are OMITTED so better-auth infers the origin from the inbound request Host.
 * This is the fix for the latent prod bug — CI never set `BETTER_AUTH_URL`, so
 * the old env-binding path shipped `http://localhost:3000` as prod's auth URL.
 */
export const BetterAuthLive = Layer.effect(
	BetterAuth.BetterAuth,
	Effect.gen(function* () {
		const connection = yield* Cloudflare.D1Connection.bind(PhoenixDb);
		const env = yield* Cloudflare.WorkerEnvironment;

		// Mint (or recover from state) the session-signing secret. `Random` is a
		// deterministic-in-state resource: the value is generated once on create
		// and persisted thereafter, so re-deploys keep the same secret unless the
		// resource is replaced. The fixed dev fallback `DEV_BETTER_AUTH_SECRET`
		// (`worker/env.ts`) is no longer in the wire — alchemy state is
		// the source of truth now.
		const SECRET = yield* Random("BETTER_AUTH_SECRET");
		const secret = yield* SECRET.text;

		// Read `ENVIRONMENT` back off the worker env by decoding the one field we
		// need (no cast). `Schema.Struct` ignores excess keys by default, so the
		// other bindings on `env` don't make the decode fail. `ENVIRONMENT` is
		// declared on the worker's `env` block (`index.ts`), resolved fail-closed
		// to "production" at deploy time. A decode failure here means the worker
		// env is malformed — unrecoverable — so it dies rather than widening the
		// Layer's error channel.
		const {ENVIRONMENT} = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ENVIRONMENT: Schema.optional(Schema.String)}),
		)(env).pipe(Effect.orDie);
		const isDev = ENVIRONMENT === "development";

		// Dev: hand better-auth the explicit browser origin so its cookie storage
		// works behind the Vite proxy (the worker sees `Host: 127.0.0.1:<port>`,
		// not the browser origin). `http`, not `https` — keeps the cookie host-only
		// on `http://localhost` (no `Secure` flag). Prod: OMIT both so better-auth
		// infers the origin from the inbound request Host (the latent-bug fix — CI
		// never set `BETTER_AUTH_URL`, so the old path shipped localhost in prod).
		const authUrlConfig = isDev
			? {
					baseURL: "http://localhost:3000",
					trustedOrigins: ["http://localhost:3000", "http://localhost:5173"],
				}
			: {};

		const auth = yield* Effect.gen(function* () {
			const d1 = yield* connection.raw;
			const secretText = yield* secret.pipe(Effect.map(Redacted.value));
			const db = drizzle(d1, {schema});
			return makeBetterAuth({
				emailAndPassword: {enabled: true},
				database: drizzleAdapter(db, {provider: "sqlite", schema}),
				secret: secretText,
				// Dev sets `baseURL`/`trustedOrigins` explicitly (ADR 0031); prod omits
				// both so better-auth infers the origin from the request Host. Derived
				// from `ENVIRONMENT` above.
				...authUrlConfig,
				user: {
					additionalFields: {
						username: {
							type: "string",
							required: false,
							// Public API can't write `username` — only the server-side
							// `setUsername` mutation (through `Pasaport`) can.
							input: false,
						},
					},
				},
				plugins: [
					// Emits the `set-auth-token` response header that the SPA's `authClient`
					// (apps/web/src/auth/client.ts) consumes — it sends back as
					// `Authorization: Bearer <token>` for cross-origin / storage-partitioned
					// auth paths. Don't remove without `grep "Bearer" apps/web/src/` first.
					bearer(),
					magicLink({
						sendMagicLink: async ({email, token, url}) => {
							// Gate on the same `isDev` derived above from `ENVIRONMENT`
							// (read off `WorkerEnvironment`) — captured in this closure.
							if (isDev) {
								console.log("[pasaport] magic link", {email, token, url});
							}
						},
					}),
				],
			} satisfies BetterAuthOptions);
		}).pipe(Effect.cached);

		return {
			auth,
			fetch: Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const authInstance = yield* auth;
				const response = yield* Effect.promise(() =>
					authInstance.handler(request.source as Request),
				);
				return HttpServerResponse.fromWeb(response);
			}),
		};
	}),
).pipe(Layer.provide(Cloudflare.D1ConnectionLive));
