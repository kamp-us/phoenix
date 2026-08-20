/**
 * Dual-write FTS sync (ADR 0080): the FTS5 virtual tables are kept in lockstep with the
 * summary tables from the application write path, not D1 triggers. This module only builds
 * statements; the caller spreads them into ONE `Drizzle.batch` alongside the summary write,
 * so a crash can never desync the two. Each sync is delete-then-insert (FTS5 has no
 * `ON CONFLICT`).
 *
 * Why drizzle query builders and NOT `sql`/`db.run(sql)`: a batch item must `_prepare()` to
 * a `D1PreparedQuery` carrying a bound `.stmt`, because D1's batch driver calls
 * `preparedQuery.stmt.bind(...params)`. `db.run(sql`…`)` yields a `SQLiteRaw` whose
 * `_prepare()` returns itself with NO `.stmt`, so a parametrized raw statement throws
 * `undefined.bind` and 500s the whole write the moment it rides in a batch (#863).
 *
 * The indexed `norm` column is the Turkish-normalized title; the `slug`/`id` column is
 * `UNINDEXED`, carried only to join the match back to the summary row.
 */

import {eq} from "drizzle-orm";
import {sqliteTable, text} from "drizzle-orm/sqlite-core";
import type {FtsSyncDb, Stmt} from "../../db/Drizzle.ts";
import {normalizeSearchText} from "./normalize.ts";

// Statement-shape shims for the FTS5 virtual tables (real DDL lives in
// `migrations/0002_search_fts.sql`). Only the columns the write path touches.
const termSearch = sqliteTable("term_search", {
	slug: text("slug").primaryKey(),
	norm: text("norm").notNull(),
});

const postSearch = sqliteTable("post_search", {
	id: text("id").primaryKey(),
	norm: text("norm").notNull(),
});

export const syncTermSearch = (db: FtsSyncDb, slug: string, title: string): [Stmt, Stmt] => [
	db.delete(termSearch).where(eq(termSearch.slug, slug)),
	db.insert(termSearch).values({slug, norm: normalizeSearchText(title)}),
];

export const removeTermSearch = (db: FtsSyncDb, slug: string): Stmt =>
	db.delete(termSearch).where(eq(termSearch.slug, slug));

export const syncPostSearch = (db: FtsSyncDb, id: string, title: string): [Stmt, Stmt] => [
	db.delete(postSearch).where(eq(postSearch.id, id)),
	db.insert(postSearch).values({id, norm: normalizeSearchText(title)}),
];

export const removePostSearch = (db: FtsSyncDb, id: string): Stmt =>
	db.delete(postSearch).where(eq(postSearch.id, id));
