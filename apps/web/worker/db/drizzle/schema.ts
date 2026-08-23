/**
 * Phoenix D1 schema (binding `PHOENIX_DB`), D1-direct per ADR 0009. The auth tables
 * (`user`, `session`, `account`, `verification`, `apikey`) are owned by better-auth
 * through its drizzle adapter, not by us.
 */
import {sql} from "drizzle-orm";
import {index, integer, primaryKey, real, sqliteTable, text} from "drizzle-orm/sqlite-core";
import {NOTIFICATION_TARGET_KINDS} from "../../features/bildirim/target.ts";
import {STORED_TIERS} from "../../features/kunye/standing.ts";
import {REPORT_STATUSES, RESOLUTIONS} from "../../features/report/resolution.ts";
import {KARMA_EVENT_REASONS} from "../karma-event.ts";
import {REACTION_EMOJI} from "../reaction-emoji.ts";
import {TARGET_KINDS} from "../target-kind.ts";

// The shared read-model tables live in `@kampus/db-schema` so worker, preview-seed,
// and fts-backfill import ONE declaration. drizzle-kit reads this module for migration
// generation, so re-exporting feeds migrations exactly as a local declaration would.
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
	// `system` is the seeded `@[silinen]` sentinel that carries re-attributed content
	// from deleted accounts (ADR 0097). Seeded by migration, never creatable at runtime.
	type: text("type", {enum: ["human", "bot", "system"]})
		.notNull()
		.default("human"),
	// Vestigial. Moderation authority moved onto the `moderates` relation tuple (ADR
	// 0107 §4) — never read this column as authority. `input:false` to better-auth.
	role: text("role", {enum: ["member", "moderator"]})
		.notNull()
		.default("member"),
	// Server-managed authorship tier (ADR 0107 §4). `visitor` is never stored — it is
	// the no-account read. Only the server promotion path writes it; `input:false` to
	// better-auth so no client write can escalate. Read via `Kunye.tierOf`, never from
	// session state.
	tier: text("tier", {enum: [...STORED_TIERS]})
		.notNull()
		.default("çaylak"),
	// Null = never promoted, OR promoted before this column existed (no backfill — the
	// founding cohort predates it). Stamped in the same batch as the `tier` flip, so it
	// can only be set on the write that flips the tier. `input:false`+`returned:false`.
	promotedAt: timestamp("promoted_at"),
	emailVerified: integer("email_verified", {mode: "boolean"}),
	// Public handle: 3–30 chars, lowercase ASCII + digits + `-`, no leading/
	// trailing `-`. UNIQUE allows multiple NULLs (SQLite) so unbooted accounts coexist.
	username: text("username").unique(),
	createdAt: timestamp("created_at"),
	updatedAt: timestamp("updated_at"),
	// Account-deletion tombstone (ADR 0097). Set ⇒ the row was scrubbed but KEPT, so the
	// `author_id → silinen` redirect and the FKs stay coherent and the email can
	// re-register fresh.
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
	// `configId` + `referenceId` are the exact property names the pinned
	// @better-auth/api-key plugin indexes this table object by on every create; a
	// mismatch 500s the mint (#108). `referenceId` keeps the SQL column `user_id`
	// because the reference IS the user id — no rename migration needed.
	configId: text("config_id").notNull().default("default"),
	name: text("name"),
	start: text("start"),
	prefix: text("prefix"),
	key: text("key").notNull(),
	referenceId: text("user_id")
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
 * Append-only ban/unban log. Ban-state is NOT a flag on `user` — it is a projection of
 * the latest event here (`resolveBanState`), so state can never diverge from history.
 * `Pasaport.validateSession` reads it per request, so a banned user's EXISTING session
 * is refused rather than just a flag toggled.
 */
export const userBanEvent = sqliteTable(
	"user_ban_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, {onDelete: "cascade"}),
		action: text("action", {enum: ["ban", "unban"]}).notNull(),
		actorId: text("actor_id").notNull(),
		reason: text("reason"),
		// Null = permanent (or an `unban`). A past `expiresAt` projects to not-banned, so
		// an expired ban self-lifts with no sweep.
		expiresAt: timestamp("expires_at"),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [index("user_ban_event_user_created").on(t.userId, sql`${t.createdAt} DESC`)],
);

/**
 * Append-only email delivery-failure log, latest-event-wins like {@link userBanEvent}
 * (`resolveEmailDeliveryState`). Keyed by `address`, not user: a send can target an
 * address with no `user` row, so `userId` is a nullable `set null` FK and the address
 * stays the stable key across an account deletion.
 */
export const emailDeliveryEvent = sqliteTable(
	"email_delivery_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").references(() => user.id, {onDelete: "set null"}),
		address: text("address").notNull(),
		action: text("action", {enum: ["fail", "clear"]}).notNull(),
		// NULLABLE, unlike ban's NOT NULL: this log is multi-writer, and the send-time
		// capture and the CF async ingestion are non-admin appenders with no actor.
		actorId: text("actor_id"),
		reason: text("reason"),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		index("email_delivery_event_address_created").on(t.address, sql`${t.createdAt} DESC`),
		index("email_delivery_event_user_created").on(t.userId, sql`${t.createdAt} DESC`),
	],
);

/**
 * Append-only platform-role assignment log, latest-event-wins like
 * {@link userBanEvent}. Written alongside the authoritative `relation_tuple` write in
 * the same mutation, so the audit trail cannot drift from the grant.
 */
export const userRoleEvent = sqliteTable(
	"user_role_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, {onDelete: "cascade"}),
		// The role this action assigned: `moderator` writes the `moderates` tuple,
		// `member` clears it.
		role: text("role", {enum: ["member", "moderator"]}).notNull(),
		actorId: text("actor_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [index("user_role_event_user_created").on(t.userId, sql`${t.createdAt} DESC`)],
);

/**
 * Per-(definition, voter) up-vote presence row. `user_vote` and
 * `definition_record.score` are denormalized off this, recomputed inline in the same
 * D1 batch as the vote write.
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

/** Single-row stats table (id = 1 is the only row), maintained by `recomputeSozlukStats`. */
export const sozlukStats = sqliteTable("sozluk_stats", {
	id: integer("id").primaryKey().default(1),
	totalDefinitions: integer("total_definitions").notNull().default(0),
	totalTerms: integer("total_terms").notNull().default(0),
	totalAuthors: integer("total_authors").notNull().default(0),
	updatedAt: timestamp("updated_at").notNull(),
});

export const postVote = sqliteTable(
	"post_vote",
	{
		postId: text("post_id").notNull(),
		voterId: text("voter_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [primaryKey({columns: [t.postId, t.voterId]}), index("post_vote_post").on(t.postId)],
);

/** Per-(post, user) bookmark ("kaydet"). Pure presence — no score or value column. */
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

/** Single-row stats table, maintained by `recomputePanoStats` / `makePersistPanoStats`. */
export const panoStats = sqliteTable("pano_stats", {
	id: integer("id").primaryKey().default(1),
	totalPosts: integer("total_posts").notNull().default(0),
	totalComments: integer("total_comments").notNull().default(0),
	totalAuthors: integer("total_authors").notNull().default(0),
	updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Per-user-per-target vote presence, powering `myVote`. Up-only — a row means voted,
 * so there is no `value` column and a retract is a delete.
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
 * Per-(user, target) reaction. Social-only and UNGATED — a logged-in çaylak may react;
 * no karma, no tier gate, the deliberate divergence from Vote. The composite PK caps it
 * at one reaction per user per item, so a change is an upsert on `emoji`. Counts are
 * computed on read (`COUNT(*)` GROUP BY emoji) — deliberately no count-cache row to
 * keep coherent.
 */
export const userReaction = sqliteTable(
	"user_reaction",
	{
		userId: text("user_id").notNull(),
		targetKind: text("target_kind", {enum: [...TARGET_KINDS]}).notNull(),
		targetId: text("target_id").notNull(),
		emoji: text("emoji", {enum: [...REACTION_EMOJI]}).notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		primaryKey({columns: [t.userId, t.targetKind, t.targetId]}),
		// Reverse lookup; hydrates the per-target aggregate (COUNT GROUP BY emoji).
		index("user_reaction_target").on(t.targetKind, t.targetId),
	],
);

/**
 * One-directional member mute ("sustur"): a row means muter has muted muted. The
 * `muted_id` reverse index serves the batched `Mute.readMutedIds` read, so read-masking
 * stamps without an N+1.
 */
export const userMute = sqliteTable(
	"user_mute",
	{
		muterId: text("muter_id").notNull(),
		mutedId: text("muted_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [primaryKey({columns: [t.muterId, t.mutedId]}), index("user_mute_muted").on(t.mutedId)],
);

/**
 * Per-user denormalized profile row. `total_karma` is an accumulator maintained in
 * `Vote.cast`'s batch; its per-bump provenance lives in {@link karmaEvent}, co-committed
 * in that same batch.
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
	},
	(t) => [index("user_profile_username").on(t.username)],
);

/**
 * Append-only provenance ledger for `user_profile.total_karma`, co-committed in
 * `Vote.cast`'s batch so a delta can never land without its event. A retraction is a
 * NEGATIVE-`delta` row, never a mutation or delete, so `SUM(delta)` per user
 * reconstructs the accumulator exactly.
 */
export const karmaEvent = sqliteTable(
	"karma_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, {onDelete: "cascade"}),
		delta: integer("delta").notNull(),
		sourceKind: text("source_kind", {enum: [...TARGET_KINDS]}).notNull(),
		sourceId: text("source_id").notNull(),
		reason: text("reason", {enum: [...KARMA_EVENT_REASONS]}).notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [index("karma_event_user_created").on(t.userId, sql`${t.createdAt} DESC`)],
);

/**
 * Per-(reporter, target) content report. The composite PK makes a re-report by the same
 * user an idempotent no-op. `status` is the ADR 0098 resolution machine. No live view
 * publishes off this — a report is private moderation state, not a client-cached entity.
 */
export const contentReport = sqliteTable(
	"content_report",
	{
		id: text("id").notNull(),
		reporterId: text("reporter_id").notNull(),
		targetKind: text("target_kind", {enum: [...TARGET_KINDS]}).notNull(),
		targetId: text("target_id").notNull(),
		reason: text("reason"),
		// Status + resolution enums source from `features/report/resolution.ts` so the
		// columns cannot drift from the machine.
		status: text("status", {enum: [...REPORT_STATUSES]})
			.notNull()
			.default("open"),
		createdAt: timestamp("created_at").notNull(),
		// Audit triad — written only on a terminal transition, all three NULL while open.
		resolverId: text("resolver_id"),
		resolvedAt: timestamp("resolved_at"),
		resolution: text("resolution", {enum: [...RESOLUTIONS]}),
		// ONE shared id stamped across every target resolved in a single wave gesture, so
		// the batch reopens as a unit (ADR 0138). NULL on a single-target resolve.
		waveId: text("wave_id"),
	},
	(t) => [
		primaryKey({columns: [t.reporterId, t.targetKind, t.targetId]}),
		index("content_report_target").on(t.targetKind, t.targetId),
		index("content_report_wave").on(t.waveId),
	],
);

/**
 * ReBAC relation-tuple store (ADR 0107). A tuple's presence IS the grant. There is
 * **no runtime write path** — tuples are minted offline, deliberately fail-closed;
 * do not add one (CLAUDE.md "Sözlük seed", the deleted fail-open `/api/admin/*`).
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
 * Authorship-vouch ledger (ADR 0107). Its own table rather than a `relation_tuple`
 * because a vouch IS a runtime write by a signed-in yazar and that table has no runtime
 * write path. No FK to `user` — an account anonymize must not cascade-erase the
 * historical vouching act.
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

/**
 * The bildirim spine's one table. `kind` is deliberately WITHOUT a D1 enum, so each
 * emitter adds its own kinds with no migration. The target may be removed later, so the
 * read path resolves liveness at list time rather than through an FK. `count` is the
 * aggregate slot ("3 yeni oy") an aggregating emitter bumps in place. `actor_id` carries
 * no FK, so an account deletion never cascade-erases a recipient's history.
 */
export const notification = sqliteTable(
	"notification",
	{
		id: text("id").primaryKey(),
		recipientId: text("recipient_id").notNull(),
		kind: text("kind").notNull(),
		targetKind: text("target_kind", {enum: [...NOTIFICATION_TARGET_KINDS]}).notNull(),
		targetId: text("target_id").notNull(),
		actorId: text("actor_id"),
		count: integer("count").notNull().default(1),
		readAt: timestamp("read_at"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(t) => [
		index("notification_recipient_read").on(t.recipientId, t.readAt),
		index("notification_recipient_created").on(t.recipientId, sql`${t.createdAt} DESC`),
	],
);

/**
 * mecmua's own long-form authoring store, deliberately NOT a reuse of pano
 * `post_record`. `published_at` IS the draft/publish lifecycle: null ⇒ an unpublished
 * draft, masked from public reads by `MecmuaPostVisibility`. Multiple drafts per author
 * are allowed — the deliberate divergence from pano, so no partial unique index here.
 */
export const mecmuaPost = sqliteTable(
	"mecmua_post",
	{
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		body: text("body").notNull().default(""),
		slug: text("slug"),
		authorId: text("author_id").notNull(),
		publishedAt: timestamp("published_at"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(t) => [index("mecmua_post_author_created").on(t.authorId, sql`${t.createdAt} DESC`)],
);

/**
 * The mecmua reader→author follow edge. A dedicated table rather than the generic
 * `relation_tuple`, which has no runtime write path.
 */
export const mecmuaSubscription = sqliteTable(
	"mecmua_subscription",
	{
		authorId: text("author_id").notNull(),
		subscriberId: text("subscriber_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		// One subscription per (subscriber, author) — a re-subscribe is an idempotent no-op.
		primaryKey({columns: [t.subscriberId, t.authorId]}),
		index("mecmua_subscription_subscriber").on(t.subscriberId, sql`${t.createdAt} DESC`),
	],
);

/**
 * The yazar's "çaylak katkılarını yerinde göster" opt-in (#6422, epic #4306).
 * Presence IS the preference: a row means this account opted in, its absence means
 * it did not — there is no `false` row, so "opted in but we don't know when" is
 * unrepresentable and an opt-out is a delete. Its own table rather than a
 * `user_profile` column because `user_profile` is a recomputable denormalized
 * summary cache (karma + contribution counts, rebuildable from its sources); this
 * row is authored user intent that no recompute could restore. Written inline by
 * `CaylakVisibility.set` (D1-direct, see ADR 0009).
 */
export const caylakVisibilityPreference = sqliteTable("caylak_visibility_preference", {
	userId: text("user_id").primaryKey(),
	setAt: timestamp("set_at").notNull(),
});

/**
 * One UTC-day presence marker per user (#7029, epic #6767): a row means a validated
 * session existed for this user on this day. Append-only and forward-only — capture
 * ships live on deploy with no backfill because a day that already passed is gone
 * (founder ruling R1.2 on #7028). Written by the memoized upsert in
 * `features/pasaport/user-activity-day.ts`, never read by the write path.
 */
export const userActivityDay = sqliteTable(
	"user_activity_day",
	{
		userId: text("user_id").notNull(),
		day: text("day").notNull(),
	},
	(t) => [primaryKey({columns: [t.userId, t.day]})],
);

/**
 * Per-signup-cohort weekly survival rollup (#7030, epic #6767): one row per signup
 * week (`cohort_week` = the UTC Monday bucket of `user.created_at`) holding the
 * five-stage funnel counts — signed up, returned any of days 2–7, first contribution,
 * vouched, promoted, each within 7 days of signup — plus raw D1/D7 return counts.
 * Written ONLY by the idempotent weekly rollup fold (`features/funnel/cohort-rollup.ts`),
 * which recomputes every row from live tables each pass, so no read ever depends on a
 * stale increment surviving.
 */
export const cohortWeekRollup = sqliteTable("cohort_week_rollup", {
	cohortWeek: text("cohort_week").primaryKey(),
	signedUp: integer("signed_up").notNull(),
	returnedDays2to7: integer("returned_days_2_to_7").notNull(),
	firstContributed7d: integer("first_contributed_7d").notNull(),
	vouched7d: integer("vouched_7d").notNull(),
	promoted7d: integer("promoted_7d").notNull(),
	d1Returned: integer("d1_returned").notNull(),
	d7Returned: integer("d7_returned").notNull(),
	d1ReturnRate: real("d1_return_rate").notNull(),
	d7ReturnRate: real("d7_return_rate").notNull(),
});
