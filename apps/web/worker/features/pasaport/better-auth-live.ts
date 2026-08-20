/**
 * Phoenix's `BetterAuth` Layer — forked from `@alchemy.run/better-auth`'s
 * `CloudflareD1` because that one declares its own D1 while phoenix's better-auth
 * tables live on the shared `PhoenixDb` (ADR 0009), reached through the `Database`
 * seam so auth and every feature run on one handle. The fork also carries
 * phoenix-only plugins and reads its secret from a binding, not `alchemy/Random`.
 */

import * as BetterAuth from "@alchemy.run/better-auth";
import {apiKey} from "@better-auth/api-key";
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
import type {} from "zod/v4/core";
import {AppConfig, betterAuthSecret, type Environment} from "../../config.ts";
import {Database} from "../../db/Database.ts";
import * as schema from "../../db/drizzle/schema.ts";
import {PHOENIX_APEX_HOSTNAME} from "../../env.ts";
import {authBridgeFetch} from "./auth-bridge.ts";
import {type EmailMessage, EmailSender} from "./email-sender.ts";
import {
	changeEmailConfirmationEmail,
	magicLinkEmail,
	verificationEmail,
} from "./email-templates.ts";

type AdditionalUserFields = NonNullable<NonNullable<BetterAuthOptions["user"]>["additionalFields"]>;

/**
 * Every field here is `input:false`, and that is the security invariant: `role`
 * (ADR 0098) and `tier` (ADR 0107 §4) are granted only by server-side paths, so no
 * client, session or registration write may set or escalate them. A pure value so
 * the invariant is unit-assertable rather than buried in the Layer's Effect.
 */
export const additionalUserFields = {
	username: {type: "string", required: false, input: false},
	role: {type: "string", required: false, input: false},
	tier: {type: "string", required: false, input: false},
	promotedAt: {type: "date", required: false, input: false, returned: false},
} satisfies AdditionalUserFields;

// The agent half of the rate mechanism (ADR 0044 Decision 3): each key gets its own
// rolling window, so a runaway key can't starve the others. Deliberately generous, and
// coupled to the per-user session-path backstop in #110 — keep the two in step.
export const apiKeyRateLimit = {
	enabled: true,
	timeWindow: 1000 * 60 * 60, // 1 hour
	maxRequests: 1000,
} as const;

/**
 * The origin/cookie config per deploy class (ADR 0088), pure over `environment` so
 * it is unit-testable without the alchemy provider stack.
 *
 *   - development → the worker sees `Host: 127.0.0.1:<port>` behind the Vite proxy,
 *     not the browser origin, so the browser origins must be named explicitly (#704).
 *   - preview → a preview is never served at a `*.phoenix.kamp.us` host (#983), so
 *     `allowedHosts` resolves per request, scoped to our own workers.dev subdomain.
 *   - production → pinning the apex trusts exactly that origin for CSRF and scopes
 *     the session cookie to the `phoenix.kamp.us` HOST. With no
 *     `crossSubDomainCookies` it never widens to `.kamp.us`, so the cookie cannot
 *     leak to sibling apps on other subdomains.
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

export const BetterAuthLive = Layer.effect(
	BetterAuth.BetterAuth,
	Effect.gen(function* () {
		const raw = yield* Database;

		// Not the reference layer's `alchemy/Random`: that is a deploy-time resource with
		// no value in the workerd isolate, so better-auth signed cookies with an
		// unresolved Effect. `orDie` — a missing secret is an unrecoverable misconfig.
		const secret = yield* betterAuthSecret.pipe(Effect.orDie);

		// Fail-closed: a missing `ENVIRONMENT` lands in prod mode and closes every dev
		// gate below.
		const {environment} = yield* AppConfig.pipe(Effect.orDie);

		// The transactional-email port (ADR 0101). `send` cannot fail, so a delivery
		// problem never throws into better-auth and fails the sign-in/verify flow.
		const emailSender = yield* EmailSender;
		const sendEmail = (message: EmailMessage): Promise<void> =>
			Effect.runPromise(emailSender.send(message));

		const authUrlConfig = deriveAuthUrlConfig(environment);

		const auth = yield* Effect.gen(function* () {
			const db = drizzle(raw, {relations: defineRelations(schema)});
			return makeBetterAuth({
				emailAndPassword: {enabled: true},
				// `experimental.joins` MUST stay off: the adapter emits an RQB-v1 raw-SQL `eq()`
				// where-shape, but our drizzle-orm is RQB-v2 (`defineRelations`), which feeds
				// `where` into `relationsFilterToSQL` with no SQL pass-through → any better-auth
				// read on the joins path (not just sign-up) 500s. Re-enabling (to collapse the
				// 2-query session read) needs the pre-scoped pnpm patch or an RQB-v2 adapter —
				// tracked in #2291; blast-site context in #2286.
				database: drizzleAdapter(db, {provider: "sqlite", schema}),
				secret: Redacted.value(secret),
				...authUrlConfig,
				emailVerification: {
					// We deliberately do NOT set `requireEmailVerification`: the link goes out
					// on signup, but sign-in is not gated on it and auto-sign-in still issues
					// the session (#995).
					sendOnSignUp: true,
					sendVerificationEmail: async ({user, url}) => {
						await sendEmail(verificationEmail(user.email, url));
					},
				},
				user: {
					// The confirmation goes to the CURRENT address, which is what verifies the
					// switch before it applies (#75).
					changeEmail: {
						enabled: true,
						sendChangeEmailConfirmation: async ({user, newEmail, url}) => {
							await sendEmail(changeEmailConfirmationEmail(user.email, newEmail, url));
						},
					},
					additionalFields: additionalUserFields,
				},
				plugins: [
					// Emits the `set-auth-token` header the SPA's `authClient` sends back as
					// `Authorization: Bearer <token>` on cross-origin / storage-partitioned
					// auth paths. Don't remove without `grep "Bearer" apps/web/src/` first.
					bearer(),
					magicLink({
						sendMagicLink: async ({email, url}) => {
							await sendEmail(magicLinkEmail(email, url));
						},
					}),
					// Durable agent credentials (ADR 0044 Decision 3). `enableSessionForAPIKeys`
					// is load-bearing, not decorative: it defaults false, and the plugin only
					// registers its session-from-key hook for a flag-on config, so without it an
					// `x-api-key` header never mints a session and every key-auth'd read
					// resolves anonymous.
					apiKey({rateLimit: apiKeyRateLimit, enableSessionForAPIKeys: true}),
				],
			} satisfies BetterAuthOptions);
		}).pipe(Effect.cached);

		return {
			auth,
			fetch: Effect.gen(function* () {
				const authInstance = yield* auth;
				return yield* authBridgeFetch((request) => authInstance.handler(request));
			}),
		};
	}),
);
