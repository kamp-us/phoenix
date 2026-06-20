/**
 * The slice of the phoenix D1 schema this seed writes — the three read-model
 * tables the unauth e2e specs sample (`term_summary`, `definition_view`,
 * `post_summary`). Column names mirror the canonical migration
 * (`apps/web/worker/db/drizzle/migrations/0000_d1_baseline.sql`); this is a
 * deliberately narrow local copy so the seed tool stays a self-contained
 * `packages/` CLI rather than pulling in the whole `@kampus/web` worker graph.
 * (This duplication is the cost noted in #903 — a canonical rename like
 * `deleted_at → removed_at` must be mirrored here by hand.)
 *
 * Timestamp columns are `integer({mode:"timestamp"})` — drizzle stores them as
 * unix SECONDS, the same encoding the worker's reads decode. The fixture builder
 * hands `Date` values; drizzle does the seconds conversion at the boundary.
 */
import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

export const termSummary = sqliteTable("term_summary", {
	slug: text("slug").primaryKey(),
	title: text("title").notNull(),
	firstLetter: text("first_letter").notNull(),
	definitionCount: integer("definition_count").notNull().default(0),
	totalScore: integer("total_score").notNull().default(0),
	excerpt: text("excerpt"),
	topDefinitionId: text("top_definition_id"),
	firstAt: timestamp("first_at"),
	lastActivityAt: timestamp("last_activity_at"),
	lastEditAt: timestamp("last_edit_at"),
	lastEventId: text("last_event_id").notNull().default(""),
});

export const definitionView = sqliteTable("definition_view", {
	id: text("id").primaryKey(),
	authorId: text("author_id").notNull(),
	authorName: text("author_name").notNull(),
	termSlug: text("term_slug").notNull(),
	termTitle: text("term_title").notNull(),
	body: text("body").notNull().default(""),
	bodyExcerpt: text("body_excerpt").notNull(),
	score: integer("score").notNull().default(0),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	removedAt: timestamp("removed_at"),
	lastEventId: text("last_event_id").notNull().default(""),
});

export const postSummary = sqliteTable("post_summary", {
	id: text("id").primaryKey(),
	slug: text("slug"),
	title: text("title").notNull(),
	url: text("url"),
	host: text("host"),
	body: text("body").notNull().default(""),
	bodyExcerpt: text("body_excerpt"),
	authorId: text("author_id").notNull(),
	authorName: text("author_name").notNull(),
	tags: text("tags").notNull().default(""),
	score: integer("score").notNull().default(0),
	commentCount: integer("comment_count").notNull().default(0),
	hotScore: integer("hot_score").notNull().default(0),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	lastActivityAt: timestamp("last_activity_at").notNull(),
	removedAt: timestamp("removed_at"),
	lastEventId: text("last_event_id").notNull().default(""),
});

/**
 * The FTS5 search tables (`term_search` / `post_search`, ADR 0080), modeled as
 * plain drizzle tables over their two columns. The migration declares them as
 * `CREATE VIRTUAL TABLE … USING fts5(…)`; drizzle-kit can't express that, but the
 * seed only needs to delete+insert two columns, which a plain `sqliteTable` maps
 * cleanly. Modeled here (rather than reusing the worker's raw-`sql` `syncTermSearch`
 * builders) so the seed's FTS writes are real drizzle `insert`/`delete` builders —
 * batch-compatible (`SQLiteRaw` from `db.run(sql)` has no `.stmt`, so it can't ride
 * the D1 `batch`). The indexed `norm` is still the worker's OWN `normalizeSearchText`
 * (imported in seed.ts), so the value is byte-identical to the dual-write's.
 */
export const termSearch = sqliteTable("term_search", {
	slug: text("slug").notNull(),
	norm: text("norm").notNull(),
});

export const postSearch = sqliteTable("post_search", {
	id: text("id").notNull(),
	norm: text("norm").notNull(),
});

export const seedSchema = {termSummary, definitionView, postSummary, termSearch, postSearch};
export type SeedSchema = typeof seedSchema;
