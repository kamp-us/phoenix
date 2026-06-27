/**
 * The minimal drizzle schema the founder seed touches — a local slice, NOT a
 * `@kampus/web` import (the worker's `schema.ts` isn't an exported subpath, and
 * pulling the whole worker graph into a `packages/` CLI is the anti-pattern
 * `@kampus/moderator-grant` avoids the same way). Canonical schema:
 * `apps/web/worker/db/drizzle/schema.ts`; `relation_tuple` is added by migration
 * `0010_relation_tuple`.
 */
import {index, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	role: text("role", {enum: ["member", "moderator"]})
		.notNull()
		.default("member"),
});

export const relationTuple = sqliteTable(
	"relation_tuple",
	{
		subject: text("subject").notNull(),
		relation: text("relation").notNull(),
		object: text("object").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.subject, t.relation, t.object]}),
		index("relation_tuple_object").on(t.object, t.relation),
	],
);

export const seedSchema = {user, relationTuple};
