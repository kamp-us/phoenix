/**
 * Phoenix D1 schema (binding `PHOENIX_DB`). Canonical store for every product
 * domain — ADR 0009 (d1-direct): there is no derivation step, the D1 shape *is*
 * the shape. The auth tables (`user`, `session`, `account`, `verification`,
 * `apikey`) are owned by better-auth via its drizzle adapter; everything else by
 * the relevant feature module (sozluk, pano, vote, pasaport).
 */
import {sql} from "drizzle-orm";
import {index, integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

/**
 * Username is NULL until the bootstrap step completes; immutable thereafter (the
 * `setUsername` mutation enforces this).
 */
export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name"),
	email: text("email").notNull(),
	image: text("image"),
	// `system` is the reserved discriminant of the seeded `@[silinen]` sentinel
	// user (ADR 0097) — a real row that is neither a human nor a bot; it carries
	// re-attributed content from deleted accounts. Seeded by migration, never
	// creatable at runtime.
	type: text("type", {enum: ["human", "bot", "system"]})
		.notNull()
		.default("human"),
	// Server-managed moderation capability (ADR 0098). Born `member`; flipped to
	// `moderator` only by the offline grant script — declared `input:false` to
	// better-auth (`better-auth-live.ts`), so no client write can reach it. Read at
	// the point of use via `Moderator.required` (through Pasaport), never trusted
	// from session state. Reconciled onto the platform role/AC model under #873.
	role: text("role", {enum: ["member", "moderator"]})
		.notNull()
		.default("member"),
	emailVerified: integer("email_verified", {mode: "boolean"}),
	// Public handle: 3–30 chars, lowercase ASCII + digits + `-`, no leading/
	// trailing `-`. UNIQUE allows multiple NULLs (SQLite) so unbooted accounts coexist.
	username: text("username").unique(),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
	// Account-deletion tombstone (ADR 0097). Null = a live account; set ⇒ the row
	// was scrubbed by `account.delete` (email/name/image nulled) but KEPT so the
	// `author_id → silinen` redirect and the FKs stay coherent and the email can
	// re-register fresh. Identity rows (session/account/apikey/verification) are
	// torn down; this stamp marks the surviving tombstone.
	deletedAt: timestamp("deleted_at"),
});

export const session = sqliteTable("session", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, {onDelete: "cascade"}),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").unique(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
});

export const account = sqliteTable("account", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, {onDelete: "cascade"}),
	accountId: text("account_id"),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	idToken: text("id_token"),
	password: text("password"),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
});

export const verification = sqliteTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
});

export const apikey = sqliteTable("apiKey", {
	id: text("id").primaryKey(),
	name: text("name"),
	start: text("start"),
	prefix: text("prefix"),
	key: text("key").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, {onDelete: "cascade"}),
	refillInterval: integer("refill_interval"),
	refillAmount: integer("refill_amount"),
	lastRefillAt: integer("last_refill_at", {mode: "timestamp"}),
	enabled: integer("enabled", {mode: "boolean"}).notNull().default(true),
	rateLimitEnabled: integer("rate_limit_enabled", {mode: "boolean"}).notNull().default(false),
	rateLimitTimeWindow: integer("rate_limit_time_window"),
	rateLimitMax: integer("rate_limit_max"),
	requestCount: integer("request_count").notNull().default(0),
	remaining: integer("remaining"),
	lastRequest: integer("last_request", {mode: "timestamp"}),
	expiresAt: integer("expires_at", {mode: "timestamp"}),
	permissions: text("permissions"),
	metadata: text("metadata"),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
});

/**
 * One row per term, keyed by slug. Maintained by the `TermChanged` projection step.
 */
export const termSummary = sqliteTable(
	"term_summary",
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
		index("term_summary_recent").on(t.lastActivityAt),
		index("term_summary_popular").on(t.totalScore),
		index("term_summary_letter").on(t.firstLetter),
	],
);

/**
 * Per-definition row. Canonical store for sozluk definitions after d1-direct
 * (ADR 0009) — the per-term DO is no longer the source of truth. Denormalized
 * with term slug + title so the profile feed renders without joining
 * `term_summary`; `body_excerpt` is a denormalized truncation for the feed card.
 *
 * `last_event_id` is vestigial (projection-era convergence guard, unused under
 * d1-direct); kept to hold the read-side schema stable until a cleanup pass.
 */
export const definitionView = sqliteTable(
	"definition_view",
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
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// WHERE author_id = ? ORDER BY created_at DESC (profile feed).
		index("definition_view_author_created").on(t.authorId, t.createdAt),
		// WHERE term_slug = ? AND removed_at IS NULL (term page).
		index("definition_view_term_score").on(t.termSlug, t.score),
	],
);

/**
 * Per-(definition, voter) up-vote presence row. `user_vote` and
 * `definition_view.score` (COUNT(*) under `WHERE definition_id = ?`) are both
 * denormalized off this, recomputed inline in the same D1 batch as the vote write.
 */
export const definitionVote = sqliteTable(
	"definition_vote",
	{
		definitionId: text("definition_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.definitionId, t.voterId]}),
		index("definition_vote_definition").on(t.definitionId),
	],
);

/**
 * Single-row stats table for the landing page (id = 1 is the only row).
 * Maintained by the `SozlukStatsChanged` projection step.
 */
export const sozlukStats = sqliteTable("sozluk_stats", {
	id: integer("id").primaryKey().default(1),
	totalDefinitions: integer("total_definitions").notNull().default(0),
	totalTerms: integer("total_terms").notNull().default(0),
	totalAuthors: integer("total_authors").notNull().default(0),
	updatedAt: timestamp("updated_at").notNull(),
});

/**
 * One row per post. Maintained by the `PostChanged` projection step.
 */
export const postSummary = sqliteTable(
	"post_summary",
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
		// The ADR 0096 removal triad (see `definition_view`). `removed_at` is the
		// former `deleted_at`. Pano posts that hard-deleted pre-substrate are gone
		// and not reconstructable; new removals are soft `Removed`, karma kept.
		removedAt: timestamp("removed_at"),
		removedBy: text("removed_by"),
		removedReason: text("removed_reason"),
		// Draft (taslak) marker — nullable, no default, mirroring the `removedAt`
		// soft-state shape: existing/published rows are `null` (= not a draft). A
		// partial unique index (`post_summary_one_draft_per_author`, migration 0004)
		// enforces one draft per author. Drafts are excluded from public feeds.
		isDraft: integer("is_draft", {mode: "boolean"}),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		index("post_summary_hot").on(t.hotScore),
		index("post_summary_new").on(t.createdAt),
		index("post_summary_top").on(t.score),
		index("post_summary_discuss").on(t.commentCount),
		index("post_summary_host").on(t.host),
		// `created_at DESC` via a `sql` fragment: drizzle 0.45's index DSL can't
		// express per-column ordering, and SQLite must walk forward for the
		// newest-first profile feed read.
		index("post_summary_author_created").on(t.authorId, sql`${t.createdAt} DESC`),
	],
);

/** Per-(post, voter) up-vote presence row. Mirrors `definitionVote`. */
export const postVote = sqliteTable(
	"post_vote",
	{
		postId: text("post_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [primaryKey({columns: [t.postId, t.voterId]}), index("post_vote_post").on(t.postId)],
);

/**
 * Per-(post, user) bookmark ("kaydet") presence row. Pure presence — a row
 * means saved, its absence means not; no score or value column (the structural
 * difference from `postVote`, which the score cache reads). The `(user_id,
 * created_at DESC)` index serves a future newest-first saved-posts list, the
 * same `sql` DESC-fragment idiom as `post_summary_author_created`.
 */
export const postBookmark = sqliteTable(
	"post_bookmark",
	{
		postId: text("post_id").notNull(),
		userId: text("user_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.postId, t.userId]}),
		index("post_bookmark_user_created").on(t.userId, sql`${t.createdAt} DESC`),
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
export const commentView = sqliteTable(
	"comment_view",
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
		// The ADR 0096 removal triad (see `definition_view`). `removed_at` is the
		// former `deleted_at`.
		removedAt: timestamp("removed_at"),
		removedBy: text("removed_by"),
		removedReason: text("removed_reason"),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// WHERE author_id = ? ORDER BY created_at DESC (profile feed).
		index("comment_view_author_created").on(t.authorId, t.createdAt),
		// WHERE post_id = ? ORDER BY created_at ASC (per-post thread).
		index("comment_view_post").on(t.postId),
		// Reply-aware soft-delete children-of-parent check.
		index("comment_view_parent").on(t.parentId),
	],
);

/** Per-(comment, voter) up-vote presence row. Mirrors `postVote` and `definitionVote`. */
export const commentVote = sqliteTable(
	"comment_vote",
	{
		commentId: text("comment_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.commentId, t.voterId]}),
		index("comment_vote_comment").on(t.commentId),
	],
);

/**
 * Single-row stats for the landing page. Maintained by `PanoStatsChanged`.
 */
export const panoStats = sqliteTable("pano_stats", {
	id: integer("id").primaryKey().default(1),
	totalPosts: integer("total_posts").notNull().default(0),
	totalComments: integer("total_comments").notNull().default(0),
	totalAuthors: integer("total_authors").notNull().default(0),
	updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Per-user-per-target vote presence table powering the `myVote` view field.
 * Up-only in the MVP — presence of a row means voted, absence means not; there
 * is no `value` column. Maintained by `VoteRecorded` (insert on vote, delete on
 * retract).
 */
export const userVote = sqliteTable(
	"user_vote",
	{
		userId: text("user_id").notNull(),
		// 'definition' | 'post' | 'comment'
		targetKind: text("target_kind").notNull(),
		targetId: text("target_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.userId, t.targetKind, t.targetId]}),
		// Reverse lookup; also hydrates myVote in batch from a list of target ids.
		index("user_vote_target").on(t.targetKind, t.targetId),
	],
);

/**
 * Per-user denormalized profile row. `total_karma` is the running sum of upvotes
 * received across all of this user's contributions, maintained by `VoteRecorded`
 * and `UserProfileChanged`.
 */
export const userProfile = sqliteTable(
	"user_profile",
	{
		userId: text("user_id").primaryKey(),
		// Nullable until bootstrap, immutable once set. UNIQUE allows multiple NULLs
		// (SQLite) for backfilled rows without a username yet.
		username: text("username").unique(),
		displayName: text("display_name"),
		image: text("image"),
		totalKarma: integer("total_karma").notNull().default(0),
		definitionCount: integer("definition_count").notNull().default(0),
		postCount: integer("post_count").notNull().default(0),
		commentCount: integer("comment_count").notNull().default(0),
		updatedAt: timestamp("updated_at").notNull(),
		// Convergence guard owned by identity events (UserProfileChanged);
		// counter-touching steps (VoteRecorded, …) leave it alone.
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [index("user_profile_username").on(t.username)],
);

/**
 * Per-(reporter, target) content-report presence row, polymorphic over the same
 * three targets Vote spans (`post` | `comment` | `definition`). The composite PK
 * `(reporter_id, target_kind, target_id)` makes a re-report by the same user an
 * idempotent no-op (`onConflictDoNothing`), mirroring `user_vote`.
 *
 * `status` is the resolution state machine (ADR 0098): born `'open'`, terminal
 * at `'resolved'` | `'dismissed'`. A terminal transition is the only writer of
 * the audit triad (`resolverId`/`resolvedAt`/`resolution`) — a resolved row is
 * uninhabitable without all three, so "resolved but we don't know who/what" is
 * unrepresentable. No live view publishes off this — a report is private
 * moderation state, not a client-cached entity.
 */
export const contentReport = sqliteTable(
	"content_report",
	{
		id: text("id").notNull(),
		reporterId: text("reporter_id").notNull(),
		// 'post' | 'comment' | 'definition'
		targetKind: text("target_kind").notNull(),
		targetId: text("target_id").notNull(),
		// Optional free-text reason supplied by the reporter.
		reason: text("reason"),
		// Resolution state machine (ADR 0098): 'open' | 'resolved' | 'dismissed'.
		status: text("status", {enum: ["open", "resolved", "dismissed"]})
			.notNull()
			.default("open"),
		createdAt: timestamp("created_at").notNull(),
		// Audit triad — written only on a terminal transition, NULL while open.
		resolverId: text("resolver_id"),
		resolvedAt: timestamp("resolved_at"),
		// The decision the resolver made: 'removed' (target soft-deleted via the
		// substrate) | 'dismissed' (report unfounded, no action).
		resolution: text("resolution", {enum: ["removed", "dismissed"]}),
	},
	(t) => [
		primaryKey({columns: [t.reporterId, t.targetKind, t.targetId]}),
		// Reverse lookup: reports against a given target (moderation read path +
		// free repeat-offender count, ADR 0098 §5).
		index("content_report_target").on(t.targetKind, t.targetId),
	],
);
