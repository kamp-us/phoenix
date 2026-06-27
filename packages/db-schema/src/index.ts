/**
 * `@kampus/db-schema` — the single canonical Drizzle declaration of the D1
 * tables that more than one package reads: `term_record`, `definition_record`,
 * `post_record`, `comment_record`. All four are authoritative **mutated stores
 * of record** (D1-direct, ADR 0009); they carry the `_record` suffix so the name
 * reads as "store of record" and stays distinct from the fate
 * `DefinitionView`/`CommentView` data-view tags one capital apart (#853, #1041).
 * The suffix marks a **cross-package / shared** store of record specifically — not
 * "every mutated store of record carries `_record`": worker-private mutated stores
 * (`user_profile`, `content_report`, the stats singletons) are equally authoritative
 * but live in the worker schema without the suffix, because they aren't duplicated by
 * any package (see SCOPE below).
 * This is a LEAF (depends only
 * on `drizzle-orm`), so the worker, `@kampus/preview-seed`, and
 * `@kampus/fts-backfill` can all import from it with no dependency cycle —
 * `fts-backfill` already prod-depends on `@kampus/web`, and the repo deliberately
 * keeps `apps/web → fts-backfill` off the graph, so the shared source CANNOT be
 * the worker schema imported directly (issue #859, #903).
 *
 * Before this package, each of the three re-declared these tables by hand, pinned
 * only by a "mirror the canonical migration" docblock — so a column change
 * (ADR 0096's `deleted_at → removed_at`, ADR 0093's `is_draft`) silently failed
 * to propagate and was caught only by real-D1 CI at deploy/runtime. Now there is
 * ONE declaration: a column rename here is reflected in all three consumers by
 * construction, caught by typecheck.
 *
 * SCOPE: only the *shared* read-model tables live here. Worker-only tables (the
 * better-auth tables, the vote/bookmark presence rows, the stats singletons,
 * `user_profile`, `content_report`) stay in `apps/web/worker/db/drizzle/schema.ts`
 * — they aren't duplicated by any package, so hoisting them would just couple the
 * leaf to worker-private shape. The FTS5 virtual tables (`term_search` /
 * `post_search`) are likewise NOT here: the worker never models them as drizzle
 * tables (they're raw-`sql`-synced, ADR 0080, and drizzle-kit can't emit
 * `CREATE VIRTUAL TABLE`), and `apps/web/worker/db/drizzle.config.ts` reads this
 * graph for migration generation — adding them would make drizzle-kit try to
 * generate a migration for a table the FTS migration already owns.
 *
 * `last_event_id` columns are the projection-era convergent-overwrite guard,
 * vestigial under d1-direct (ADR 0009) but kept to hold the read-side stable.
 */
import {sql} from "drizzle-orm";
import {index, integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

/**
 * One row per term, keyed by slug. Canonical store for sozluk terms under
 * d1-direct (ADR 0009) — the D1 row IS the term; deleting it destroys it.
 */
export const termRecord = sqliteTable(
	"term_record",
	{
		slug: text("slug").primaryKey(),
		title: text("title").notNull(),
		// Lower-cased first character; powers the alphabet pivot on SozlukHome.
		firstLetter: text("first_letter").notNull(),
		definitionCount: integer("definition_count").notNull().default(0),
		totalScore: integer("total_score").notNull().default(0),
		// Body of the highest-scoring non-deleted definition, truncated.
		excerpt: text("excerpt"),
		topDefinitionId: text("top_definition_id"),
		firstAt: timestamp("first_at"),
		lastActivityAt: timestamp("last_activity_at"),
		lastEditAt: timestamp("last_edit_at"),
		// Convergent-overwrite guard: `WHERE last_event_id < excluded.last_event_id`.
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		index("term_record_recent").on(t.lastActivityAt),
		index("term_record_popular").on(t.totalScore),
		index("term_record_letter").on(t.firstLetter),
	],
);

/**
 * Per-definition row. Canonical store for sozluk definitions after d1-direct
 * (ADR 0009) — the per-term DO is no longer the source of truth. Denormalized
 * with term slug + title so the profile feed renders without joining
 * `term_record`; `body_excerpt` is a denormalized truncation for the feed card.
 *
 * `last_event_id` is vestigial (projection-era convergence guard, unused under
 * d1-direct); kept to hold the read-side schema stable until a cleanup pass.
 */
export const definitionRecord = sqliteTable(
	"definition_record",
	{
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
		// The ADR 0096 removal triad. `removed_at` null ⇒ Live; this column IS the
		// former `deleted_at`, repurposed. `removed_by`/`removed_reason` carry the
		// audit. Projected to `EntityLifecycle` — services never read these raw.
		removedAt: timestamp("removed_at"),
		removedBy: text("removed_by"),
		removedReason: text("removed_reason"),
		// The çaylak mod-only sandbox marker (#1205) — on the SAME ADR 0096 lifecycle
		// substrate as the removal triad, not a parallel scheme. `sandboxed_at` null ⇒
		// not sandboxed; a çaylak's new content is stamped sandboxed (visible to the
		// author + moderators only) until promotion (#1206). Projected to
		// `EntityLifecycle.Sandboxed`: the closed union makes sandboxed-AND-removed
		// unrepresentable, and `toColumns` never emits `sandboxed_at` AND `removed_at`
		// both non-null. Services never read this raw.
		sandboxedAt: timestamp("sandboxed_at"),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// WHERE author_id = ? ORDER BY created_at DESC (profile feed).
		index("definition_record_author_created").on(t.authorId, t.createdAt),
		// WHERE term_slug = ? AND removed_at IS NULL (term page).
		index("definition_record_term_score").on(t.termSlug, t.score),
		// WHERE sandboxed_at IS NOT NULL AND removed_at IS NULL — the moderator
		// sandbox queue / a çaylak's promotion backlog (#1206 read-model seam).
		index("definition_record_sandboxed").on(t.sandboxedAt),
	],
);

/**
 * One row per post. Canonical store for pano posts under d1-direct (ADR 0009) —
 * the per-post DO is no longer the source of truth; the D1 row IS the post.
 */
export const postRecord = sqliteTable(
	"post_record",
	{
		id: text("id").primaryKey(),
		slug: text("slug"),
		title: text("title").notNull(),
		// Submission URL (link posts). Denormalized so the feed renders without
		// RPCing into the per-post DO.
		url: text("url"),
		// Extracted via `new URL(url).host` on submit. Powers the host filter.
		host: text("host"),
		// Canonical full-text body under D1-direct; `body_excerpt` stays for feed cards.
		body: text("body").notNull().default(""),
		bodyExcerpt: text("body_excerpt"),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		// Comma-separated tags from the fixed enum (göster/tartışma/soru/söylenme/meta).
		tags: text("tags").notNull().default(""),
		score: integer("score").notNull().default(0),
		commentCount: integer("comment_count").notNull().default(0),
		// HN-style hot score: f(score, age). Recomputed on every PostChanged.
		hotScore: integer("hot_score").notNull().default(0),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
		lastActivityAt: timestamp("last_activity_at").notNull(),
		// The ADR 0096 removal triad (see `definition_record`). `removed_at` is the
		// former `deleted_at`. Pano posts that hard-deleted pre-substrate are gone
		// and not reconstructable; new removals are soft `Removed`, karma kept.
		removedAt: timestamp("removed_at"),
		removedBy: text("removed_by"),
		removedReason: text("removed_reason"),
		// The çaylak mod-only sandbox marker (#1205) — see `definition_record`.
		sandboxedAt: timestamp("sandboxed_at"),
		// Draft (taslak) marker — nullable, no default, mirroring the `removedAt`
		// soft-state shape: existing/published rows are `null` (= not a draft). A
		// partial unique index (`post_record_one_draft_per_author`, migration 0004)
		// enforces one draft per author. Drafts are excluded from public feeds.
		isDraft: integer("is_draft", {mode: "boolean"}),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		index("post_record_hot").on(t.hotScore),
		index("post_record_new").on(t.createdAt),
		index("post_record_top").on(t.score),
		index("post_record_discuss").on(t.commentCount),
		index("post_record_host").on(t.host),
		// `created_at DESC` via a `sql` fragment: drizzle 0.45's index DSL can't
		// express per-column ordering, and SQLite must walk forward for the
		// newest-first profile feed read.
		index("post_record_author_created").on(t.authorId, sql`${t.createdAt} DESC`),
		// The moderator sandbox queue / promotion backlog (#1206 read-model seam).
		index("post_record_sandboxed").on(t.sandboxedAt),
	],
);

/**
 * Per-comment row, denormalized with post id + title for the profile feed AND
 * the per-post thread reader. Canonical store for pano comments after d1-direct
 * (ADR 0009) — the per-post DO is no longer the source of truth.
 *
 * A removed comment that still has live replies stays as a `Removed` row (its
 * canonical body kept for restore + moderator review); the `[silindi]` tombstone
 * is a VIEW rendering of that state, not a body the delete path writes (ADR 0096
 * §5). A removed leaf comment is also a `Removed` row now — no hard delete.
 *
 * `last_event_id` is vestigial (projection-era convergence guard, unused under
 * d1-direct); kept to hold the read-side schema stable until a cleanup pass.
 */
export const commentRecord = sqliteTable(
	"comment_record",
	{
		id: text("id").primaryKey(),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		postId: text("post_id").notNull(),
		postTitle: text("post_title").notNull(),
		// NULL for top-level comments; nested replies point at a non-removed
		// comment in the same post.
		parentId: text("parent_id"),
		body: text("body").notNull().default(""),
		bodyExcerpt: text("body_excerpt").notNull(),
		score: integer("score").notNull().default(0),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
		// The ADR 0096 removal triad (see `definition_record`). `removed_at` is the
		// former `deleted_at`.
		removedAt: timestamp("removed_at"),
		removedBy: text("removed_by"),
		removedReason: text("removed_reason"),
		// The çaylak mod-only sandbox marker (#1205) — see `definition_record`.
		sandboxedAt: timestamp("sandboxed_at"),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// WHERE author_id = ? ORDER BY created_at DESC (profile feed).
		index("comment_record_author_created").on(t.authorId, t.createdAt),
		// WHERE post_id = ? ORDER BY created_at ASC (per-post thread).
		index("comment_record_post").on(t.postId),
		// Reply-aware soft-delete children-of-parent check.
		index("comment_record_parent").on(t.parentId),
		// The moderator sandbox queue / promotion backlog (#1206 read-model seam).
		index("comment_record_sandboxed").on(t.sandboxedAt),
	],
);
