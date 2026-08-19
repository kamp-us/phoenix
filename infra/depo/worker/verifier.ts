/**
 * The auth seam: resolve a presented pasaport `apiKey` to its owning user id
 * (ADR 0144 decision 4; the agent-credential path of ADRs 0044/0045).
 *
 * It verifies against the SAME better-auth `apiKey` table pasaport owns, on the
 * shared `phoenix_db`. Verification is delegated to the `@better-auth/api-key`
 * plugin's own `verifyApiKey` — the doorman must never re-derive the key hash or
 * the enabled/expiry rules itself (the plugin's `defaultKeyHasher` is an internal
 * detail). A minimal better-auth instance over phoenix_db keeps depo dumb: it
 * borrows pasaport's credential store and owns none of its schema or migrations.
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
	readonly userId: string;
}

export interface ApiKeyVerifierService {
	readonly verify: (key: string | null) => Effect.Effect<AuthenticatedCaller, Unauthorized>;
}

export class ApiKeyVerifier extends Context.Service<ApiKeyVerifier, ApiKeyVerifierService>()(
	"depo/ApiKeyVerifier",
) {}

/**
 * `referenceId` is the plugin's owning entity — the pasaport user id. Anything
 * that is not a valid, enabled key, and any thrown error, is a flat `Unauthorized`
 * with no detail leaked to the caller. `secret` is pasaport's own, passed so any
 * secret-dependent apiKey path matches its issuer.
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
