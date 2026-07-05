/**
 * The minimal `user`-table drizzle slice the author-email scrub JOINs against — a local
 * slice, NOT a `@kampus/web` import (the worker's auth `schema.ts` isn't an exported subpath,
 * and pulling the whole worker graph into a `packages/` CLI is the anti-pattern
 * `@kampus/moderator-grant` / `@kampus/preview-seed` avoid the same way). Only the identity
 * columns the recompute reads: `id` (the `author_id` join key), and the nullable `name` /
 * `username` the label rule flattens.
 *
 * These BetterAuth tables live on the SAME shared `PhoenixDb` D1 as the `_record` tables
 * (ADR 0009; `apps/web/worker/features/pasaport/better-auth-live.ts` — "phoenix's better-auth
 * tables live on the shared `PhoenixDb` D1"), so the scrub's `author_id = user.id` JOIN is
 * resolvable in a single D1 query — the identity data is reachable, no DO / external store
 * reach. The canonical `user` schema is `apps/web/worker/db/drizzle/schema.ts`.
 */
import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const scrubUser = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name"),
	username: text("username").unique(),
	createdAt: integer("created_at", {mode: "timestamp"}),
	updatedAt: integer("updated_at", {mode: "timestamp"}),
});

/**
 * The fixed fallback noun for an author with neither a display name nor a username — the SAME
 * `kullanıcı` `authorDisplayLabel` (`apps/web/worker/features/pasaport/author-label.ts`)
 * returns. Restated here (the worker module isn't importable from a `packages/` CLI); the
 * parity is locked by `scrub-author-email.unit.test.ts`.
 */
export const AUTHOR_FALLBACK_LABEL = "kullanıcı";
