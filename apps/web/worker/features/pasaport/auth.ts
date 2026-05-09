import {env} from "cloudflare:workers";
// Re-anchor transitive type specifiers away from `.pnpm/<hash>/...` paths
// so tsgo can portably name plugin types under composite project refs.
// See microsoft/typescript-go#1034 and better-auth#5666 for context.
import type {} from "@better-auth/core";
import {type Auth as BetterAuth, type BetterAuthOptions, betterAuth} from "better-auth";
import {drizzleAdapter} from "better-auth/adapters/drizzle";
import {bearer, magicLink} from "better-auth/plugins";
import type {} from "better-call";
import type {DrizzleSqliteDODatabase} from "drizzle-orm/durable-sqlite";
import type {} from "zod/v4/core";
import * as schema from "./drizzle/schema";

export const createAuth = (db: DrizzleSqliteDODatabase<typeof schema>) =>
	betterAuth({
		emailAndPassword: {enabled: true},
		database: drizzleAdapter(db, {provider: "sqlite", schema}),
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

export type Auth = BetterAuth;
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
