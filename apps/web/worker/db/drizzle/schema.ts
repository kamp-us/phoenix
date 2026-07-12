/**
 * Phoenix D1 schema (binding `PHOENIX_DB`). Canonical store for every product
 * domain — ADR 0009 (d1-direct): there is no derivation step, the D1 shape *is*
 * the shape. The auth tables (`user`, `session`, `account`, `verification`,
 * `apikey`) are owned by better-auth via its drizzle adapter; everything else by
 * the relevant feature module (sozluk, pano, vote, pasaport).
 */
import {sql} from "drizzle-orm";
import {index, integer, primaryKey, sqliteTable, text} from "drizzle-orm/sqlite-core";
import {NOTIFICATION_TARGET_KINDS} from "../../features/bildirim/target.ts";
import {STORED_TIERS} from "../../features/kunye/standing.ts";
import {REPORT_STATUSES, RESOLUTIONS} from "../../features/report/resolution.ts";
import {KARMA_EVENT_REASONS} from "../karma-event.ts";
import {REACTION_EMOJI} from "../reaction-emoji.ts";
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
	// Vestigial moderation role (was ADR 0098's authority source). ADR 0107 §4 moved
	// moderation authority off this column onto the `moderates` relation tuple — read
	// at the point of use via the `Moderate` capability (`RelationStore`), never
	// `role`. Declared `input:false` to better-auth (`better-auth-live.ts`), so no
	// client write can reach it; retained for back-compat, not read as authority.
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
	// When the account was promoted `çaylak → yazar` (#1590). Null = never promoted,
	// or promoted before this column existed (the founding cohort predates it — v1
	// measures time-to-promotion forward only, no backfill). Stamped atomically inside
	// `Pasaport.promoteToYazar` in the same batch as the `tier` flip (ADR 0013/0014),
	// so it can only be set on the exact write that flips the tier — server-only, never
	// client-writable (declared `input:false` + `returned:false` to better-auth,
	// `better-auth-live.ts`). A thin nullable signal, NOT an analytics/event stream.
	promotedAt: timestamp("promoted_at"),
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
 * Append-only ban/unban event log — the SINGLE source of both the audit trail and
 * the current ban-state (ADR 0107 admin-gated moderation, epic #968). Ban-state is
 * NOT a mutable flag on `user` (the never-migrated better-auth `banned`/`banReason`/
 * `banExpires` columns are deliberately not resurrected): it is a projection of the
 * latest event for a user (see `features/pasaport/ban.ts` `resolveBanState`), so
 * "current state diverged from history" is unrepresentable — every ban and every
 * unban is one immutable row carrying its actor, reason, expiry, and time.
 *
 * Enforcement reads the latest row per request at the session boundary
 * (`Pasaport.validateSession`), so a banned user's EXISTING session is refused, not
 * just a flag toggled. The `(user_id, created_at DESC)` index is that hot read's
 * key. `onDelete: cascade` ties the log to the account row (account-deletion is a
 * kept tombstone, ADR 0097, so the row — and this history — survive a deletion).
 */
export const userBanEvent = sqliteTable(
	"user_ban_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, {onDelete: "cascade"}),
		// The event kind: a `ban` opens/refreshes a ban, an `unban` lifts it. The
		// projection reads only the latest row, so an `unban` after a `ban` restores
		// access without mutating or deleting the ban row — full reversibility.
		action: text("action", {enum: ["ban", "unban"]}).notNull(),
		// The admin who performed the action (a discharged `Admin` grant's account id).
		actorId: text("actor_id").notNull(),
		// Ban reason (required at the mutation boundary for a `ban`); null for an `unban`.
		reason: text("reason"),
		// Optional ban expiry; null = permanent (or an `unban`). A past `expiresAt`
		// projects to not-banned (see `resolveBanState`), so an expired ban self-lifts.
		expiresAt: timestamp("expires_at"),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [index("user_ban_event_user_created").on(t.userId, sql`${t.createdAt} DESC`)],
);

/**
 * Append-only transactional-email delivery-failure log — the SINGLE source of both
 * the audit trail and the current per-address failing-state (email-bounce epic #2687).
 * Failing-state is a projection of the latest event for an address (see
 * `features/pasaport/email-delivery.ts` `resolveEmailDeliveryState`), mirroring
 * {@link userBanEvent}: latest-event-wins, so a stale "bouncing flag" is
 * unrepresentable. Every feed appends here — the send-time capture (Child #2691), the
 * admin mark/clear (Child #2692), and the CF async ingestion (Child #2694).
 *
 * The recipient is keyed by `address` (always known from the send), with `userId` a
 * nullable FK when the address resolves to an account — a send can target an address
 * with no `user` row. `onDelete: set null` keeps the delivery history when the account
 * is deleted (the address remains the stable key).
 */
export const emailDeliveryEvent = sqliteTable(
	"email_delivery_event",
	{
		id: text("id").primaryKey(),
		userId: text("user_id").references(() => user.id, {onDelete: "set null"}),
		address: text("address").notNull(),
		// A `fail` opens/refreshes a failing-state, a `clear` lifts it. The projection
		// reads only the latest row, so a `clear` after a `fail` restores deliverability
		// without mutating or deleting the fail row — full reversibility, as in ban.
		action: text("action", {enum: ["fail", "clear"]}).notNull(),
		// The failure detail (a `SendEmailError` message, or an admin note); null for a `clear`.
		reason: text("reason"),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		index("email_delivery_event_address_created").on(t.address, sql`${t.createdAt} DESC`),
		index("email_delivery_event_user_created").on(t.userId, sql`${t.createdAt} DESC`),
	],
);

/**
 * Append-only runtime feature-flag override log — the SINGLE source of both the audit
 * trail and the current per-flag runtime override (admin-console epic #2711, #2741). The
 * effective override is a projection of the latest event for a flag key (see
 * `features/flagship/flag-override.ts` `resolveFlagOverride`), mirroring {@link userBanEvent}
 * / {@link emailDeliveryEvent}: latest-event-wins, so an admin's runtime flip can never
 * drift from history and every prod flip is auditable by construction.
 *
 * `action` is tri-state: `on`/`off` force the flag's effective value, `clear` lifts the
 * override (the projection then reads the real Flagship evaluation). The `actor_id` is the
 * discharged `Admin` grant's account id (plain text, no FK — the audit stamp mirrors
 * `user_ban_event.actor_id`). The `(flag_key, created_at DESC)` index is the projection's
 * hot read key. No `user`/account FK — the row is keyed by flag, not account.
 */
export const flagOverrideEvent = sqliteTable(
	"flag_override_event",
	{
		id: text("id").primaryKey(),
		// The Flagship flag key the override targets (the shared `src/flags/keys.ts` constant).
		flagKey: text("flag_key").notNull(),
		// The event kind: `on`/`off` force the effective value, `clear` lifts the override.
		// The projection reads only the latest row, so a `clear` after an `on`/`off` restores
		// the real evaluation without mutating or deleting the forcing row — full reversibility.
		action: text("action", {enum: ["on", "off", "clear"]}).notNull(),
		// The admin who performed the flip (a discharged `Admin` grant's account id).
		actorId: text("actor_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [index("flag_override_event_key_created").on(t.flagKey, sql`${t.createdAt} DESC`)],
);

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
 * Maintained inline by `recomputeSozlukStats` (D1-direct, see ADR 0009).
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
 * Single-row stats for the landing page. Maintained inline by
 * `recomputePanoStats` / `makePersistPanoStats` (D1-direct, see ADR 0009).
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
 * is no `value` column. Maintained inline by `Vote.cast`'s atomic batch (insert
 * on vote, delete on retract; D1-direct, see ADR 0009).
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
 * Per-(user, target) reaction presence row — the third instance of the
 * polymorphic per-user-presence pattern (after `user_vote` / `post_bookmark`),
 * modeled on the karma-free / ungated `post_bookmark` shape, polymorphic over
 * the same three targets Vote spans (`definition` | `post` | `comment`, the
 * shared `TARGET_KINDS` taxonomy). Social-only and UNGATED: a logged-in çaylak
 * may react — no karma column, no tier gate (the deliberate divergence from
 * Vote). Unlike bookmark (pure presence), a reaction carries a value: the
 * chosen `emoji`, constrained to the curated `REACTION_EMOJI` palette.
 *
 * The composite PK `(user_id, target_kind, target_id)` is the cardinality-one
 * constraint — at most one reaction per user per item, so changing a reaction
 * is an upsert on the `emoji` column (`onConflictDoUpdate`), mirroring the
 * `user_vote` cross-product PK shape. Aggregation is a `COUNT(*)` GROUP BY emoji
 * read (the display child owns the read path) — no per-(target, emoji) count
 * cache row is added here; the count is computed on read, so there is no cache
 * to keep coherent on every react.
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
 * Per-user denormalized profile row. `total_karma` is the running sum of upvotes
 * received across all of this user's contributions, maintained inline by
 * `Vote.cast`'s atomic batch (D1-direct, see ADR 0009). Its provenance — one row
 * per bump — lives in {@link karmaEvent}, co-committed in that same batch (#2592).
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
 * Append-only provenance ledger for `user_profile.total_karma` (#2592) — one row
 * per karma bump, co-committed in `Vote.cast`'s atomic batch (via the `KarmaBump`
 * contract's pasaport implementation, `features/pasaport/karma.ts`), so a delta
 * can never land without its event nor an event without its delta. The same
 * append-only-log shape as {@link userBanEvent}: a retraction is a NEGATIVE-`delta`
 * row, never a mutation or deletion of a prior one, so `SUM(delta)` per `user_id`
 * reconstructs the accumulator exactly. `reason` distinguishes the event kind
 * (`vote` cast / `retract`); `(source_kind, source_id)` names the vote target the
 * delta came from. `onDelete: cascade` ties the ledger to the account row (an
 * account deletion is a kept tombstone, ADR 0097, so this history survives it).
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
		// The wave-remove grouping identity (#1855, ADR 0138): ONE shared id stamped
		// across every target resolved in a single wave gesture, so the batch reopens
		// as a unit (#1704's restore primitive). NULL on a single-target resolve — a
		// wave groups a batch, a lone resolve has none.
		waveId: text("wave_id"),
	},
	(t) => [
		primaryKey({columns: [t.reporterId, t.targetKind, t.targetId]}),
		// Reverse lookup: reports against a given target (moderation read path +
		// free repeat-offender count, ADR 0098 §5).
		index("content_report_target").on(t.targetKind, t.targetId),
		// Reopen-by-wave lookup: the rows sharing a `wave_id` the restore reopens as a
		// unit (#1855).
		index("content_report_wave").on(t.waveId),
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

/**
 * Per-recipient notification row (#1694, epic #1666) — the bildirim spine's one
 * table. `kind` is a plain text discriminant deliberately WITHOUT a D1 enum: the
 * spine mints no notifications; each sibling emitter (#1695–#1699) introduces its
 * own kinds without a migration. `target_kind`/`target_id` reference the notified
 * entity polymorphically (the `content_report` idiom, widened by `user` — see
 * `features/bildirim/target.ts`); the target may be removed later, so the read
 * path resolves liveness at list time (tombstone), never an FK.
 *
 * Read state is the nullable `read_at` stamp — "read but we don't know when" is
 * unrepresentable. `count` is the aggregate slot ("3 yeni oy", #1698): the spine
 * writes 1, an aggregating emitter bumps it + `updated_at` in place. `actor_id`
 * is kept verbatim with NO FK (the `authorship_vouch` choice) so an account
 * deletion never cascade-erases a recipient's history.
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
		// WHERE recipient_id = ? AND read_at IS NULL (the unread-count badge).
		index("notification_recipient_read").on(t.recipientId, t.readAt),
		// WHERE recipient_id = ? ORDER BY created_at DESC (the center's keyset list).
		index("notification_recipient_created").on(t.recipientId, sql`${t.createdAt} DESC`),
	],
);

/**
 * One row per mecmua post — mecmua's OWN worker-private long-form authoring store
 * (epic #2467, #2463), NOT a reuse of pano `post_record`. mecmua is markdown
 * long-form authoring, so it carries none of pano's link-sharing columns
 * (`url`/`host`/`score`/`hot_score`/`comment_count`/`tags`) and no çaylak sandbox
 * marker.
 *
 * `published_at` IS the draft/publish lifecycle: null ⇒ an unpublished draft
 * (masked from public reads by `features/mecmua/MecmuaPostVisibility`), non-null ⇒
 * published at that instant. Multiple drafts per author are allowed — the
 * deliberate divergence from pano's one-draft-per-author partial unique index, so
 * there is none here. Worker-private, so it lives in this schema and not the shared
 * `@kampus/db-schema` leaf.
 */
export const mecmuaPost = sqliteTable(
	"mecmua_post",
	{
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		// Canonical long-form markdown body under D1-direct (ADR 0009).
		body: text("body").notNull().default(""),
		slug: text("slug"),
		authorId: text("author_id").notNull(),
		publishedAt: timestamp("published_at"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(t) => [
		// WHERE author_id = ? ORDER BY created_at DESC (an author's own posts + drafts).
		index("mecmua_post_author_created").on(t.authorId, sql`${t.createdAt} DESC`),
	],
);

/**
 * The mecmua subscribed-author edge (#2500, epic #2467) — the reader→author
 * follow relation the subscribed-author time feed reads to select authors. One row
 * per (subscriber, author) pair: `subscriber_id` follows `author_id`. Deliberately
 * MINIMAL (v1) — no display name, no notification prefs, no named-publication scope;
 * just the edge the feed keysets over. A dedicated table (not the generic
 * `relation_tuple`, which has no runtime write path) so the feed join is a plain
 * index read and the subscribe/unsubscribe writes are ordinary D1-direct mutations.
 * Worker-private, so it lives here and not the shared `@kampus/db-schema` leaf.
 */
export const mecmuaSubscription = sqliteTable(
	"mecmua_subscription",
	{
		authorId: text("author_id").notNull(),
		subscriberId: text("subscriber_id").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(t) => [
		// The edge identity — one subscription per (subscriber, author); a re-subscribe is
		// an idempotent no-op, not a duplicate row.
		primaryKey({columns: [t.subscriberId, t.authorId]}),
		// WHERE subscriber_id = ? — the feed's "which authors does this reader follow" read.
		index("mecmua_subscription_subscriber").on(t.subscriberId, sql`${t.createdAt} DESC`),
	],
);
