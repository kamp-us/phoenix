/**
 * The minimal `user`-table drizzle schema the grant CLI writes — a local slice,
 * NOT a `@kampus/web` import (the worker's `schema.ts` isn't an exported subpath,
 * and pulling the whole worker graph into a `packages/` CLI is the anti-pattern
 * `@kampus/preview-seed` avoids the same way). Only the columns the grant touches.
 * The canonical schema lives at `apps/web/worker/db/drizzle/schema.ts`; the `role`
 * column is added by migration `0007_moderation_role_resolution`.
 */
import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name"),
	email: text("email").notNull(),
	image: text("image"),
	type: text("type", {enum: ["human", "bot"]})
		.notNull()
		.default("human"),
	role: text("role", {enum: ["member", "moderator"]})
		.notNull()
		.default("member"),
	username: text("username").unique(),
	createdAt: integer("created_at", {mode: "timestamp"}),
	updatedAt: integer("updated_at", {mode: "timestamp"}),
});

export const grantSchema = {user};
