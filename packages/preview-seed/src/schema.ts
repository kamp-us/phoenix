/**
 * The slice of the phoenix D1 schema this seed writes. The read-model tables come
 * from the canonical `@kampus/db-schema` leaf so this seed can't drift from the
 * real schema (#859). That leaf depends only on `drizzle-orm`, so pulling it in
 * adds no cycle even though this package already prod-depends on `@kampus/web`.
 */
import {definitionRecord, postRecord, termRecord} from "@kampus/db-schema";
import {index, integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

export {definitionRecord, postRecord, termRecord};

/**
 * The FTS5 search tables (ADR 0080), modeled locally as plain drizzle tables: the
 * migration declares them `CREATE VIRTUAL TABLE … USING fts5(…)`, which
 * drizzle-kit can't express, so they are NOT in the `@kampus/db-schema` leaf.
 * Modeled rather than reusing the worker's raw-`sql` builders because the seed's
 * writes must ride the D1 `batch`, and `SQLiteRaw` from `db.run(sql)` has no
 * `.stmt`. The indexed `norm` still comes from the worker's own
 * `normalizeSearchText` (see seed.ts), so it stays byte-identical to the
 * dual-write's.
 */
export const termSearch = sqliteTable("term_search", {
	slug: text("slug").notNull(),
	norm: text("norm").notNull(),
});

export const postSearch = sqliteTable("post_search", {
	id: text("id").notNull(),
	norm: text("norm").notNull(),
});

/**
 * The auth slice the test-account provisioner writes — a narrow local copy of
 * `apps/web/worker/db/drizzle/schema.ts`, the way `@kampus/founder-seed` keeps one: the
 * worker's schema module is not an exported subpath, and pulling the worker graph into a
 * `packages/` CLI is the anti-pattern `@kampus/admin-grant` avoids the same way.
 *
 * `session.token` is the value better-auth signs into the session cookie, so a row written
 * here is exactly what an authenticated capture presents (see `test-account.ts`).
 */
const timestamp = (name: string) => integer(name, {mode: "timestamp"});

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name"),
	email: text("email").notNull(),
	type: text("type", {enum: ["human", "bot", "system"]})
		.notNull()
		.default("human"),
	role: text("role", {enum: ["member", "moderator"]})
		.notNull()
		.default("member"),
	tier: text("tier", {enum: ["çaylak", "yazar"]})
		.notNull()
		.default("çaylak"),
	emailVerified: integer("email_verified", {mode: "boolean"}),
	username: text("username").unique(),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
});

export const session = sqliteTable("session", {
	id: text("id").primaryKey(),
	userId: text("user_id").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").unique(),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
});

/** Added by migration `0010_relation_tuple`; moderation authority lives here, not on `user.role` (ADR 0107 §4). */
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

export const seedSchema = {
	termRecord,
	definitionRecord,
	postRecord,
	termSearch,
	postSearch,
	user,
	session,
	relationTuple,
};
export type SeedSchema = typeof seedSchema;
