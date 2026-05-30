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
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {} from "zod/v4/core";
import * as schema from "../../db/drizzle/schema.ts";
import {PhoenixDb} from "../../db/resources.ts";
import {phoenixEnvBindings} from "../../env.ts";

/**
 * The phoenix `BetterAuth` Layer — fork of `@alchemy.run/better-auth`'s
 * `CloudflareD1` reference Layer. Mirrors its structure (`Random` for the
 * secret, `Cloudflare.D1Connection.bind` for the database, `Effect.cached` so
 * the `makeBetterAuth` call happens once per isolate) and adds phoenix's
 * plugins + `baseURL`/`trustedOrigins`.
 *
 * `BETTER_AUTH_URL` and `BETTER_AUTH_TRUSTED_ORIGINS` are read from the
 * `WorkerEnvironment` at layer build (deploy-time wiring still lives in the
 * worker `env` block) — they steer cookie storage on the dev Vite proxy where
 * the worker sees `Host: 127.0.0.1:<port>` rather than the browser origin.
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

		const envRecord = env as unknown as Record<string, string | undefined>;
		const baseURL = envRecord.BETTER_AUTH_URL;
		const trustedOriginsRaw = envRecord.BETTER_AUTH_TRUSTED_ORIGINS;
		const trustedOrigins = trustedOriginsRaw
			? trustedOriginsRaw
					.split(",")
					.map((o) => o.trim())
					.filter(Boolean)
			: undefined;

		const auth = yield* Effect.gen(function* () {
			const d1 = yield* connection.raw;
			const secretText = yield* secret.pipe(Effect.map(Redacted.value));
			const db = drizzle(d1, {schema});
			return makeBetterAuth({
				emailAndPassword: {enabled: true},
				database: drizzleAdapter(db, {provider: "sqlite", schema}),
				secret: secretText,
				// Dev runs behind the Vite proxy, so the worker sees
				// `Host: 127.0.0.1:<port>` rather than the browser origin. Set
				// `baseURL`/`trustedOrigins` explicitly (ADR 0031) instead of
				// inferring from the inbound Host. We never flip `Secure` — the
				// dev cookie must stay host-only on `http://localhost`.
				...(baseURL ? {baseURL} : {}),
				...(trustedOrigins ? {trustedOrigins: [...trustedOrigins]} : {}),
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
							// Read `ENVIRONMENT` off the deploy-time `phoenixEnvBindings`
							// literal (`env.ts`) — same value the worker's `env` block
							// ships, resolved once at module-eval in the alchemy CLI. This
							// sidesteps the `cloudflare:workers` runtime entirely (no
							// dynamic import, no ambient-`Env` cast, no codegen-vs-workerd
							// resolution mismatch to worry about).
							if (phoenixEnvBindings.ENVIRONMENT === "development") {
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
