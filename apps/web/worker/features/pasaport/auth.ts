import {env} from "cloudflare:workers";
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
export const createAuth = (d1: D1Database) => {
	const db = drizzle(d1, {schema});
	return betterAuth({
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
