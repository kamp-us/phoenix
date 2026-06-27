/**
 * Phoenix D1 schema (binding `PHOENIX_DB`). Canonical store for every product
 * domain — ADR 0009 (d1-direct): there is no derivation step, the D1 shape *is*
 * the shape. The auth tables (`user`, `session`, `account`, `verification`,
 * `apikey`) are owned by better-auth via its drizzle adapter; everything else by
 * the relevant feature module (sozluk, pano, vote, pasaport).
 */
import {sql} from "drizzle-orm";
import {index, integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";
import {STORED_TIERS} from "../../features/kunye/standing.ts";
import {REPORT_STATUSES, RESOLUTIONS} from "../../features/report/resolution.ts";
import {TARGET_KINDS} from "../target-kind.ts";

// The shared read-model tables (`term_record` / `definition_record` /
// `post_record` / `comment_record`) live in the `@kampus/db-schema` leaf so the
// worker, preview-seed, and fts-backfill all import ONE declaration — a column
// rename is one edit there, caught by typecheck, not three hand-mirrored copies
// that drift (ADR 0096 `removed_at`, ADR 0093 `is_draft`; issues #859/#903).
// drizzle-kit reads this module for migration generation, so re-exporting feeds
// migrations exactly as a local declaration would.
export {commentRecord, definitionRecord, postRecord, termRecord} from "@kampus/db-schema";

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
	// Server-managed authorship tier (ADR 0107 §4) — the GLOBAL account-level
	// earned standing on the `visitor < çaylak < yazar` ladder. The column holds
	// only `çaylak | yazar` (an account is always ≥ çaylak; `visitor` is the
	// no-account read, never stored). Born `çaylak`; promoted to `yazar` only by
	// the server promotion path (#1206) / founding seed — declared `input:false`
	// to better-auth (`better-auth-live.ts`), so no client/session write can set
	// or escalate it. Read at the point of use via `Kunye.tierOf` (through
	// Pasaport), never trusted from session state.
	tier: text("tier", {enum: [...STORED_TIERS]})
		.notNull()
		.default("çaylak"),
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
 * Per-(definition, voter) up-vote presence row. `user_vote` and
 * `definition_record.score` (COUNT(*) under `WHERE definition_id = ?`) are both
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
 * same `sql` DESC-fragment idiom as `post_record_author_created`.
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
		targetKind: text("target_kind", {enum: [...TARGET_KINDS]}).notNull(),
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
		targetKind: text("target_kind", {enum: [...TARGET_KINDS]}).notNull(),
		targetId: text("target_id").notNull(),
		// Optional free-text reason supplied by the reporter.
		reason: text("reason"),
		// Status + resolution enums source from the ADR 0098 machine's tuples
		// (`features/report/resolution.ts`) so the column can't drift from it.
		status: text("status", {enum: [...REPORT_STATUSES]})
			.notNull()
			.default("open"),
		createdAt: timestamp("created_at").notNull(),
		// Audit triad — written only on a terminal transition, NULL while open.
		resolverId: text("resolver_id"),
		resolvedAt: timestamp("resolved_at"),
		// The decision the resolver made: 'removed' (target soft-deleted via the
		// substrate) | 'dismissed' (report unfounded, no action).
		resolution: text("resolution", {enum: [...RESOLUTIONS]}),
	},
	(t) => [
		primaryKey({columns: [t.reporterId, t.targetKind, t.targetId]}),
		// Reverse lookup: reports against a given target (moderation read path +
		// free repeat-offender count, ADR 0098 §5).
		index("content_report_target").on(t.targetKind, t.targetId),
	],
);

/**
 * ReBAC relation-tuple store (ADR 0107) — the `(subject, relation, object)` triples
 * that back the `Relation` capability axis (`moderates`, `admin`). A tuple's presence
 * IS the grant: `RelationStore` reads the existence check `(subject, relation, object)`,
 * served directly by the composite primary key. There is **no runtime write path** —
 * tuples are minted offline (the founder seed mints the `role='moderator'` cohort as
 * `(id, "moderates", "platform")`), the same fail-closed shape `user.role` has
 * (CLAUDE.md "Sözlük seed"; the deleted `/api/admin/*` fail-open routes). The
 * `(object, relation)` reverse index serves the "subjects holding relation R on object
 * O" listing read (e.g. the platform's moderators), mirroring the reverse-lookup index
 * on `content_report` / `user_vote`.
 */
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

/**
 * Authorship-vouch ledger (ADR 0107, #1206) — the recorded act of a `yazar`
 * vouching for a `çaylak`'s promotion. A vouch is a durable record, not a
 * relation_tuple: relation_tuple has NO runtime write path (offline-minted only),
 * whereas a vouch IS a runtime write by a signed-in yazar, so it gets its own
 * table with the vouching actor preserved.
 *
 * The composite PK `(voucher_id, candidate_id)` makes a re-vouch by the same yazar
 * for the same çaylak an idempotent no-op (`onConflictDoNothing`) — and makes
 * "a vouch with no voucher" or "a vouch with no candidate" unrepresentable (both
 * NOT NULL). The `candidate_id` reverse index serves the "who vouched for this
 * çaylak" read. There is no FK to `user` so a later account-anonymize doesn't
 * cascade-erase the historical vouching act (the actor id is kept verbatim).
 */
export const authorshipVouch = sqliteTable(
	"authorship_vouch",
	{
		voucherId: text("voucher_id").notNull(),
		candidateId: text("candidate_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.voucherId, t.candidateId]}),
		index("authorship_vouch_candidate").on(t.candidateId),
	],
);
