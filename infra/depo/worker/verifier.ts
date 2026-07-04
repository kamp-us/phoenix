/**
 * The auth seam. `ApiKeyVerifier` resolves a presented pasaport `apiKey` to its
 * owning user id, or fails `Unauthorized` (ADR 0144 decision 4; the agent-
 * credential path of ADRs 0044/0045). It is a SEAM so the upload domain unit-tests
 * with a scripted verifier and the production wiring stays out of the pure core.
 *
 * `ApiKeyVerifierLive` is the production implementation: it verifies against the
 * SAME better-auth `apiKey` table pasaport owns, on the shared `phoenix_db` D1
 * (`worker/resources.ts` adopts it read-only). Verification is delegated to the
 * `@better-auth/api-key` plugin's own `verifyApiKey` — the doorman never re-derives
 * the key hash or the enabled/expiry rules itself (grounding the credential check
 * in the plugin, not intuition: the plugin hashes with `defaultKeyHasher` =
 * base64url(SHA-256(key)), which is an internal detail the doorman must not copy).
 *
 * Building a minimal better-auth instance (drizzle-adapter + `apiKey()` plugin)
 * bound to phoenix_db keeps depo DUMB: it borrows pasaport's credential store to
 * answer one yes/no question and owns none of pasaport's schema or migrations.
 */
import {apiKey} from "@better-auth/api-key";
import type {D1Database} from "@cloudflare/workers-types";
import {betterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {drizzle} from "drizzle-orm/d1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {Unauthorized} from "./errors.ts";

export interface AuthenticatedCaller {
	/** The pasaport user id the key belongs to (uploads are attributed to it). */
	readonly userId: string;
}

export interface ApiKeyVerifierService {
	readonly verify: (key: string | null) => Effect.Effect<AuthenticatedCaller, Unauthorized>;
}

export class ApiKeyVerifier extends Context.Service<ApiKeyVerifier, ApiKeyVerifierService>()(
	"depo/ApiKeyVerifier",
) {}

/**
 * Build the production verifier over a raw `phoenix_db` handle. A per-key
 * `auth.api.verifyApiKey` round-trip returns `{valid, key: {referenceId, enabled}}`
 * (`referenceId` is the owning entity — the pasaport user id, per the plugin's
 * default `references`); anything that is not a valid, enabled key — or any thrown
 * error below — is a flat `Unauthorized` (no detail leak to the caller). `secret`
 * is pasaport's `BETTER_AUTH_SECRET`, passed so any secret-dependent apiKey path
 * matches its issuer (the hash lookup itself is secret-independent —
 * `defaultKeyHasher`).
 */
export const makeApiKeyVerifier = (db: D1Database, secret: string): ApiKeyVerifierService => {
	const auth = betterAuth({
		database: drizzleAdapter(drizzle(db), {provider: "sqlite"}),
		secret,
		plugins: [apiKey()],
	});
	return {
		verify: (key) =>
			key === null || key.length === 0
				? Effect.fail(new Unauthorized({reason: "missing api key"}))
				: Effect.tryPromise({
						try: () => auth.api.verifyApiKey({body: {key}}),
						catch: () => new Unauthorized({reason: "verification failed"}),
					}).pipe(
						Effect.flatMap((res) =>
							res.valid && res.key !== null && res.key.enabled !== false && res.key.referenceId
								? Effect.succeed<AuthenticatedCaller>({userId: res.key.referenceId})
								: Effect.fail(new Unauthorized({reason: "invalid api key"})),
						),
					),
	};
};
