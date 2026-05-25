// Re-anchor transitive type specifiers away from `.pnpm/<hash>/...` paths
// so tsgo can portably name plugin types under composite project refs.
// See microsoft/typescript-go#1034 and better-auth#5666 for context.
import type {} from "@better-auth/core";
import {type Auth as BetterAuth, type BetterAuthOptions, betterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer, magicLink} from "better-auth/plugins";
import type {} from "better-call";
import {drizzle} from "drizzle-orm/d1";
import type {} from "zod/v4/core";
import * as schema from "../../db/drizzle/schema";

/**
 * Instantiate better-auth against the canonical D1 database (binding
 * `PHOENIX_DB`). The drizzle adapter is shape-only — it doesn't care that
 * we're handing it a D1 driver instead of a Durable Object SQLite driver,
 * because both speak the SQLite dialect.
 *
 * Phoenix-specific `username` field on `user` is configured as an
 * additional field with `input: false`, so the public API can't write it —
 * only the server-side `setUsername` mutation (which goes through the
 * Pasaport module) can.
 */
export const createAuth = (d1: D1Database, secret: string | undefined) => {
	if (!secret) throw new Error("BETTER_AUTH_SECRET is not set — add it via `wrangler secret put` or .dev.vars");
	const db = drizzle(d1, {schema});
	return betterAuth({
		secret,
		emailAndPassword: {enabled: true},
		database: drizzleAdapter(db, {provider: "sqlite", schema}),
		user: {
			additionalFields: {
				username: {
					type: "string",
					required: false,
					input: false,
				},
			},
		},
		plugins: [
			bearer(),
			magicLink({
				sendMagicLink: async ({email, token, url}) => {
					// Lazy `cloudflare:workers` import (not a top-level static import):
					// the fate codegen Vite plugin imports this module graph in a plain
					// Node runner where the workerd built-in `cloudflare:workers` can't
					// resolve. A static import resolves at module load (breaking codegen);
					// a dynamic import inside this already-async callback resolves only at
					// call time, inside workerd — so codegen never touches it and the
					// dev/runtime behavior is unchanged.
					const {env} = await import("cloudflare:workers");
					if (env.ENVIRONMENT === "development") {
						console.log("[pasaport] magic link", {email, token, url});
					}
				},
			}),
		],
	} satisfies BetterAuthOptions);
};

export type Auth = BetterAuth;
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
