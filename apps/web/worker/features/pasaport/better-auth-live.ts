/**
 * Phoenix's `BetterAuth` Layer — a fork of `@alchemy.run/better-auth`'s
 * `CloudflareD1` reference Layer. Why fork instead of reuse it:
 *
 *   - `CloudflareD1` declares its OWN `D1Database("BetterAuth")`; phoenix's
 *     better-auth tables live on the shared `PhoenixDb` D1 (ADR 0009), so this
 *     Layer derives its raw d1 from the `Database` seam (ADR 0040) — the same tag
 *     `DrizzleLive` derives from, so features and auth provably share one handle.
 *   - It needs phoenix-specific plugins (`magicLink`, `bearer`), an
 *     `additionalFields.username`, and dev `baseURL`/`trustedOrigins` (ADR 0031).
 *   - It reads `BETTER_AUTH_SECRET` from a `secret_text` binding instead of minting
 *     via `alchemy/Random` (a deploy-time resource with no runtime value — see the
 *     secret comment inside the Layer).
 */

import * as BetterAuth from "@alchemy.run/better-auth";
// Re-anchor transitive type specifiers away from `.pnpm/<hash>/...` paths so
// tsgo can portably name plugin types under composite project refs.
// See microsoft/typescript-go#1034 and better-auth#5666 for context.
import type {} from "@better-auth/core";
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
import {AppConfig, betterAuthSecret} from "../../config.ts";
import {Database} from "../../db/Database.ts";
import * as schema from "../../db/drizzle/schema.ts";

// Keeps the reference layer's `Effect.cached` so `makeBetterAuth` runs once per
// isolate. The secret and `baseURL`/`trustedOrigins` rationale (and the latent
// prod bug each fixes) live at their sites below.
export const BetterAuthLive = Layer.effect(
	BetterAuth.BetterAuth,
	Effect.gen(function* () {
		// From the shared `Database` seam (ADR 0040) — the same tag `DrizzleLive`
		// derives from, so auth and every feature service run on one handle.
		const raw = yield* Database;

		// Read from the `BETTER_AUTH_SECRET` `secret_text` binding. Replaces the
		// reference layer's `alchemy/Random`: `Random` is a deploy-time resource
		// with no value in the workerd runtime isolate, so the minted secret could
		// never be read back and better-auth signed cookies with an unresolved
		// Effect. `orDie`: a missing secret is an unrecoverable deploy misconfig.
		const secret = yield* betterAuthSecret.pipe(Effect.orDie);

		// `Config.withDefault("production")` is fail-closed: a missing `ENVIRONMENT`
		// lands in prod mode and closes every dev gate below. `orDie`: a value
		// outside the two literals is a malformed env, unrecoverable.
		const {environment} = yield* AppConfig.pipe(Effect.orDie);
		const isDev = environment === "development";

		// Dev: explicit browser origin so cookie storage works behind the Vite proxy
		// (the worker sees `Host: 127.0.0.1:<port>`, not the browser origin). `http`
		// keeps the cookie host-only (no `Secure`). Prod: OMIT both so better-auth
		// infers the origin from the request Host — the latent-bug fix, CI never set
		// `BETTER_AUTH_URL` so the old path shipped localhost in prod.
		const authUrlConfig = isDev
			? {
					baseURL: "http://localhost:3000",
					trustedOrigins: ["http://localhost:3000", "http://localhost:5173"],
				}
			: {};

		const auth = yield* Effect.gen(function* () {
			const db = drizzle(raw, {schema});
			return makeBetterAuth({
				emailAndPassword: {enabled: true},
				database: drizzleAdapter(db, {provider: "sqlite", schema}),
				secret: Redacted.value(secret),
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
);
