/**
 * Phoenix D1 schema (binding `PHOENIX_DB`).
 *
 * Canonical store for every product domain. Resolvers read + write D1
 * directly via drizzle. ADR 0009 (d1-direct) supersedes the prior
 * "view-layer + projection" framing — there is no derivation step, the D1
 * shape *is* the shape.
 *
 * The auth tables (`user`, `session`, `account`, `verification`, `apikey`)
 * are owned by better-auth via its drizzle adapter; everything below is owned
 * directly by the relevant feature module (sozluk, pano, vote, pasaport).
 */
import {sql} from "drizzle-orm";
import {index, integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

/* -------------------------------------------------------------------------- */
/* Pasaport / better-auth tables                                               */
/* -------------------------------------------------------------------------- */

/**
 * Canonical user identity row. Owned by better-auth at write time; resolvers
 * read it directly to surface the `me` query and to look up the immutable
 * Phoenix `username` handle.
 *
 * Username is NULL until the bootstrap step completes; immutable thereafter
 * (the `setUsername` mutation enforces this).
 */
export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name"),
	email: text("email").notNull(),
	image: text("image"),
	type: text("type", {enum: ["human", "bot"]})
		.notNull()
		.default("human"),
	emailVerified: integer("email_verified", {mode: "boolean"}),
	// Phoenix-specific public handle: 3–30 chars, lowercase ASCII + digits + `-`,
	// no leading/trailing `-`. Routed by /u/<username> on the SPA. UNIQUE allows
	// multiple NULLs (SQLite semantics) so unbooted accounts coexist.
	username: text("username").unique(),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
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

/* -------------------------------------------------------------------------- */
/* Sozluk view tables                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One row per term. Slug is the key (also the DO name → `idFromName(slug)`).
 * Maintained by the `TermChanged` projection step. Reads:
 * - `terms(sort: 'recent' | 'popular' | 'alphabetic', limit, letter?)`
 * - landing-page recency / popularity columns.
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
		// Forge ULID of the projection event that wrote this row.
		// Convergent-overwrite guard: `WHERE last_event_id < excluded.last_event_id`.
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// "son eklenenler" column on SozlukHome.
		index("term_summary_recent").on(t.lastActivityAt),
		// "en çok oylananlar" column on SozlukHome.
		index("term_summary_popular").on(t.totalScore),
		// Alphabet pivot filter.
		index("term_summary_letter").on(t.firstLetter),
	],
);

/**
 * Per-author per-definition row, denormalized with term slug + title for the
 * profile contribution feed (so the feed renders without RPCing into each
 * term's DO). Maintained by `DefinitionAdded`, `DefinitionEdited`,
 * `DefinitionDeleted` projection steps.
 */
export const definitionView = sqliteTable(
	"definition_view",
	{
		id: text("id").primaryKey(),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		termSlug: text("term_slug").notNull(),
		termTitle: text("term_title").notNull(),
		// Truncated body for the feed card; full body lives in the per-term DO.
		bodyExcerpt: text("body_excerpt").notNull(),
		score: integer("score").notNull().default(0),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
		// Soft-delete flag — deleted contributions are filtered from the feed.
		deletedAt: timestamp("deleted_at"),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// Profile contribution feed: WHERE author_id = ? ORDER BY created_at DESC.
		index("definition_view_author_created").on(t.authorId, t.createdAt),
	],
);

/**
 * Single-row stats table for the landing page. id = 1 is the only row.
 * Maintained by the `SozlukStatsChanged` projection step on every event that
 * could affect totals.
 */
export const sozlukStats = sqliteTable("sozluk_stats", {
	id: integer("id").primaryKey().default(1),
	totalDefinitions: integer("total_definitions").notNull().default(0),
	totalTerms: integer("total_terms").notNull().default(0),
	totalAuthors: integer("total_authors").notNull().default(0),
	updatedAt: timestamp("updated_at").notNull(),
});

/* -------------------------------------------------------------------------- */
/* Pano view tables                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One row per post. Maintained by the `PostChanged` projection step.
 * Reads:
 * - `posts(sort: 'hot' | 'new' | 'top' | 'discuss', limit, host?)`
 * - landing recency / popularity.
 * - profile feed (filtered by author_id).
 */
export const postSummary = sqliteTable(
	"post_summary",
	{
		id: text("id").primaryKey(),
		// Optional human-friendly slug; resolver may dual-key on id or slug.
		slug: text("slug"),
		title: text("title").notNull(),
		// Original submission URL (when the post is a link, not a self-post).
		// Denormalized so the feed renders without RPCing into the per-post DO.
		url: text("url"),
		// Extracted via `new URL(url).host` on submit. Powers host filter.
		host: text("host"),
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
		// Soft-deleted posts are removed entirely from this MV by `PostDeleted`.
		deletedAt: timestamp("deleted_at"),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// "sıcak" sort.
		index("post_summary_hot").on(t.hotScore),
		// "yeni" sort.
		index("post_summary_new").on(t.createdAt),
		// "en iyi" sort.
		index("post_summary_top").on(t.score),
		// "tartışma" sort.
		index("post_summary_discuss").on(t.commentCount),
		// Host filter.
		index("post_summary_host").on(t.host),
		// Profile contribution feed: WHERE author_id = ? ORDER BY created_at DESC.
		// `created_at DESC` so SQLite walks the index forward for the "newest
		// contributions first" read on `/u/<username>`. Drizzle 0.45's index
		// DSL doesn't expose per-column ordering on columns, so the second
		// component is a `sql` fragment.
		index("post_summary_author_created").on(t.authorId, sql`${t.createdAt} DESC`),
	],
);

/**
 * Per-author per-comment row, denormalized with post id + title for the
 * profile contribution feed. Maintained by `CommentAdded`, `CommentEdited`,
 * `CommentDeleted` projection steps. Deleted-with-replies surfaces as
 * `body_excerpt = '[silindi]'`; deleted-without-replies removes the row.
 */
export const commentView = sqliteTable(
	"comment_view",
	{
		id: text("id").primaryKey(),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		postId: text("post_id").notNull(),
		postTitle: text("post_title").notNull(),
		bodyExcerpt: text("body_excerpt").notNull(),
		score: integer("score").notNull().default(0),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
		deletedAt: timestamp("deleted_at"),
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// Profile contribution feed: WHERE author_id = ? ORDER BY created_at DESC.
		index("comment_view_author_created").on(t.authorId, t.createdAt),
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

/* -------------------------------------------------------------------------- */
/* Cross-product tables                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-user-per-target vote presence table. Powers the `myVote` GraphQL field
 * on Definition / Post / Comment. Voting is up-only in the MVP — presence of
 * a row means the user has voted; absence means they haven't. There is no
 * `value` column.
 *
 * Maintained by the `VoteRecorded` projection step (insert on vote, delete
 * on retract).
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
		// Composite PK: one row per (user, target).
		primaryKey({columns: [t.userId, t.targetKind, t.targetId]}),
		// Reverse lookup (e.g. "who voted on this target") — also useful for
		// hydrating myVote in batch from a list of target ids.
		index("user_vote_target").on(t.targetKind, t.targetId),
	],
);

/**
 * Per-user denormalized profile row. Username is the public identifier and
 * routes the `/u/<username>` page. `total_karma` is the running sum of
 * upvotes received across all of this user's contributions, maintained by
 * the `VoteRecorded` and `UserProfileChanged` projection steps.
 */
export const userProfile = sqliteTable(
	"user_profile",
	{
		userId: text("user_id").primaryKey(),
		// Nullable until the user completes the bootstrap step; immutable once set.
		// SQLite UNIQUE allows multiple NULLs, which is what we want for backfilled
		// rows that haven't picked a username yet.
		username: text("username").unique(),
		displayName: text("display_name"),
		image: text("image"),
		totalKarma: integer("total_karma").notNull().default(0),
		definitionCount: integer("definition_count").notNull().default(0),
		postCount: integer("post_count").notNull().default(0),
		commentCount: integer("comment_count").notNull().default(0),
		updatedAt: timestamp("updated_at").notNull(),
		// Forge ULID convergence guard. Identity events (UserProfileChanged) own
		// this column; counter-touching steps (VoteRecorded, …) leave it alone.
		lastEventId: text("last_event_id").notNull().default(""),
	},
	(t) => [
		// `/u/<username>` route lookup.
		index("user_profile_username").on(t.username),
	],
);
