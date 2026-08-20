/**
 * The slice of the phoenix D1 schema this seed writes. The read-model tables come
 * from the canonical `@kampus/db-schema` leaf so this seed can't drift from the
 * real schema (#859). That leaf depends only on `drizzle-orm`, so pulling it in
 * adds no cycle even though this package already prod-depends on `@kampus/web`.
 */
import {definitionRecord, postRecord, termRecord} from "@kampus/db-schema";
import {sqliteTable, text} from "drizzle-orm/sqlite-core";

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

export const seedSchema = {termRecord, definitionRecord, postRecord, termSearch, postSearch};
export type SeedSchema = typeof seedSchema;
