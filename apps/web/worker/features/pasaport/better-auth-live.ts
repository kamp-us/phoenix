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
import {defineRelations} from "drizzle-orm/relations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type {} from "zod/v4/core";
import {AppConfig, betterAuthSecret, type Environment} from "../../config.ts";
import {Database} from "../../db/Database.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {PHOENIX_APEX_HOSTNAME} from "../../env.ts";
import {type EmailMessage, EmailSender} from "./email-sender.ts";
import {
	changeEmailConfirmationEmail,
	magicLinkEmail,
	verificationEmail,
} from "./email-templates.ts";

type AdditionalUserFields = NonNullable<NonNullable<BetterAuthOptions["user"]>["additionalFields"]>;

/**
 * The better-auth `user.additionalFields` shape. **Every field is `input:false`** —
 * server-managed, so no client/session/registration write can set or escalate it:
 *
 *   - `username` — written only by the server-side `setUsername` mutation (through
 *     `Pasaport`), immutable once set.
 *   - `role` — the moderation capability (ADR 0098), granted only by the offline D1
 *     grant script; NOT the better-auth admin plugin.
 *   - `tier` — the authorship tier (ADR 0107 §4), born `çaylak`, promoted to `yazar`
 *     only by the server promotion path (#1206) / founding seed. A fresh registration
 *     defaults to `çaylak` (the `user.tier` column default) — `input:false` is what
 *     keeps it un-escalatable at sign-up.
 *   - `promotedAt` — when the account was promoted to `yazar` (#1590), stamped only by
 *     `Pasaport.promoteToYazar`. `input:false` (like `tier`) keeps it un-writable from
 *     the wire; `returned:false` keeps the value off the surfaced session/user object —
 *     the readout is a separate concern (epic Child F), out of scope here.
 *
 * Extracted as a pure value so the `input:false` invariant is unit-assertable
 * (`additional-user-fields.unit.test.ts`) rather than buried in the Layer's Effect.
 */
export const additionalUserFields = {
	username: {type: "string", required: false, input: false},
	role: {type: "string", required: false, input: false},
	tier: {type: "string", required: false, input: false},
	promotedAt: {type: "date", required: false, input: false, returned: false},
} satisfies AdditionalUserFields;

/**
 * The better-auth origin/cookie config for one deploy class (ADR 0088). Pure over
 * the `environment` literal so the per-env derivation is unit-testable without the
 * alchemy provider stack. Each class gets the origin it actually serves from:
 *
 *   - development → local `alchemy dev` behind the Vite proxy: the worker sees
 *     `Host: 127.0.0.1:<port>`, NOT the browser origin, so the browser origin must
 *     be named explicitly (`localhost:3000` + Vite's `:5173`). (#704)
 *   - preview → a deployed ephemeral stage on `*.kampusinfra.workers.dev`. #983
 *     keeps the Custom Domain production-only, so a preview is NEVER served at a
 *     `*.phoenix.kamp.us` host — the dynamic `baseURL.allowedHosts` (better-auth's
 *     documented preview-deploy mechanism) resolves per request to the stage's own
 *     served origin and trusts it, scoped to OUR account's workers.dev subdomain.
 *   - production → pin `baseURL` to the apex `phoenix.kamp.us` (the live Custom
 *     Domain, #594/#983), single-sourced from `PHOENIX_APEX_HOSTNAME` so the
 *     auth-trusted origin can't drift from the bound domain. Pinning the apex trusts
 *     exactly that one origin for CSRF and scopes the session cookie to the
 *     `phoenix.kamp.us` HOST: better-auth's default cookie domain is the baseURL
 *     host, and with no `crossSubDomainCookies` it never widens to `.kamp.us`, so the
 *     cookie can't leak to sibling apps on other subdomains (no CSRF widening, ADR
 *     0085). SPA and API are the same same-origin worker, so no `trustedOrigins`
 *     add-on is needed.
 */
export const deriveAuthUrlConfig = (environment: Environment): BetterAuthOptions =>
	environment === "development"
		? {
				baseURL: "http://localhost:3000",
				trustedOrigins: ["http://localhost:3000", "http://localhost:5173"],
			}
		: // `audit` shares preview's deployed-direct topology (#1511): the rite-audit stage
			// is served from `*.kampusinfra.workers.dev`, NOT the prod apex, so it must use
			// the dynamic `allowedHosts` mechanism rather than fall through to the apex pin.
			environment === "preview" || environment === "audit"
			? {baseURL: {allowedHosts: ["*.kampusinfra.workers.dev"]}}
			: {baseURL: `https://${PHOENIX_APEX_HOSTNAME}`};

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
		// outside the three literals is a malformed env, unrecoverable.
		const {environment} = yield* AppConfig.pipe(Effect.orDie);

		// The transactional-email port (ADR 0101). Resolved once here and closed
		// over by the better-auth callbacks below, the same way `secret`/`raw` are
		// threaded. `send` is `Effect<void, never, never>` (the adapter discharged
		// its RuntimeContext + swallowed failures), so the async callbacks run it
		// with `Effect.runPromise` — and a delivery failure never throws into
		// better-auth, which would fail the sign-in/verify flow.
		const emailSender = yield* EmailSender;
		const sendEmail = (message: EmailMessage): Promise<void> =>
			Effect.runPromise(emailSender.send(message));

		// The per-deploy-class auth-origin/cookie config. See `deriveAuthUrlConfig`.
		const authUrlConfig = deriveAuthUrlConfig(environment);

		const auth = yield* Effect.gen(function* () {
			const db = drizzle(raw, {relations: defineRelations(schema)});
			return makeBetterAuth({
				emailAndPassword: {enabled: true},
				database: drizzleAdapter(db, {provider: "sqlite", schema}),
				secret: Redacted.value(secret),
				...authUrlConfig,
				// Take D1 off the session-validation hot path on the DATA plane
				// (#2274). Every authenticated `/fate` + `/fate/live` request validated
				// the session with a fresh 2-query D1 lookup (session, then user).
				// `cookieCache` serves the session from a short-lived signed cookie
				// (default `strategy: "compact"` = HMAC-SHA256), so the hot path is
				// crypto-only with ZERO D1. (Distinct from #2260, the control-plane
				// `/api/auth/get-session` endpoint — different route, different fix.)
				//
				// `maxAge` is the SESSION-REVOCATION LATENCY BOUND: within the window,
				// `getSession` trusts the signed cookie and re-checks only its embedded
				// expiry — it does NOT re-query D1 for a server-side revocation (verified
				// against better-auth@1.6.10 `api/routes/session.mjs`), so a
				// logged-out / admin-revoked / banned session stays valid until the
				// cookie expires. 60s (not better-auth's 300s default, `|| 300` in
				// `context/create-context.mjs`) bounds that lag 5× tighter. 60s is safe
				// because NO authz decision reads the cached session: moderation
				// authority is read fresh per call from the relation-tuple store
				// (`kunye/moderate.ts`), karma gates read fresh from Künye
				// (`kunye/privilege.ts`, "never trust a stale session value"), tier
				// gates read fresh via `kunye.tierOf` (`fate/layers.ts`), and
				// `CurrentActor` derives only `user.id` (`kunye/CurrentActorLive.ts`).
				// The stale-session blast radius is thus identity-continuity only
				// (treated as still-signed-in-as-self for ≤60s), never a stale
				// capability — see the PR's Staleness-safety section.
				session: {cookieCache: {enabled: true, maxAge: 60}},
				// NB: better-auth's `experimental.joins` (the cache-miss cold-path
				// 2-query→1-join optimization) is NOT enabled — it's incompatible with
				// this stack. Turning it on routes EVERY adapter read through drizzle's
				// relational query builder (`db.query[model].findFirst`), and
				// @better-auth/drizzle-adapter@1.6.10 passes a raw SQL `eq(...)`
				// expression as the RQB `where` (RQB-v1 shape). drizzle-orm@1.0.0-rc.4
				// is RQB-v2 (`defineRelations`), whose `where` must be a relational
				// filter object — it iterates the SQL object's keys and rejects the
				// internal `decoder` property (`Unknown relational filter field:
				// "decoder"`), 500ing sign-up's create→read-back. cookieCache above
				// already delivers #2274's primary win (zero D1 on the authenticated
				// hot path via the signed cookie); joins was only the secondary
				// cache-miss lever, so it's dropped rather than fought.
				// Verify a new account's email via a delivered link (the `EmailSender`
				// port; ADR 0101). Was unreachable before — no sender existed.
				emailVerification: {
					// Opens the send tap: better-auth fires `sendVerificationEmail` on
					// every email signup (sign-up.ts gates the send on `sendOnSignUp ??
					// requireEmailVerification`). We do NOT set `requireEmailVerification`,
					// so this sends the link without gating sign-in — auto-sign-in still
					// issues the session (#995).
					sendOnSignUp: true,
					sendVerificationEmail: async ({user, url}) => {
						await sendEmail(verificationEmail(user.email, url));
					},
				},
				user: {
					// `changeEmail` is off by default; enabling it + the
					// `sendChangeEmailConfirmation` callback (sent to the CURRENT address)
					// is what lets #75 verify the switch before applying it (ADR 0101).
					changeEmail: {
						enabled: true,
						sendChangeEmailConfirmation: async ({user, newEmail, url}) => {
							await sendEmail(changeEmailConfirmationEmail(user.email, newEmail, url));
						},
					},
					// All server-managed, all `input:false` — see `additionalUserFields`.
					additionalFields: additionalUserFields,
				},
				plugins: [
					// Emits the `set-auth-token` response header that the SPA's `authClient`
					// (apps/web/src/auth/client.ts) consumes — it sends back as
					// `Authorization: Bearer <token>` for cross-origin / storage-partitioned
					// auth paths. Don't remove without `grep "Bearer" apps/web/src/` first.
					bearer(),
					magicLink({
						// Deliver the magic link via the `EmailSender` port (ADR 0101). In
						// dev/preview the port is the log sink (no real send); in production
						// it goes through the CF Email Service binding.
						sendMagicLink: async ({email, url}) => {
							await sendEmail(magicLinkEmail(email, url));
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
