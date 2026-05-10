/**
 * Phoenix view-layer projection workflow.
 *
 * Single workflow class that consumes events emitted by per-entity Agents
 * (`SozlukTerm`, `PanoPost`) via the outbox + `flushOutbox` dispatcher and
 * convergent-overwrites the corresponding rows in `PHOENIX_DB`.
 *
 * Lineage: ADR 0007 (view layer — outbox + Workflows + single D1).
 *
 * The `run` method dispatches on `event.kind`. Each kind owns one
 * `step.do(...)` block; the body of each block is currently a no-op so the
 * binding compiles and downstream tasks (T2..T15) can fill in real
 * projection writes one event kind at a time.
 *
 * Conventions for the projection bodies (locked in by ADR 0007 — implementers
 * do not need to redecide these):
 *
 * - Each body is one D1 write to one MV table. No cross-table joins.
 * - Convergent overwrite guarded by `WHERE last_event_id < excluded.last_event_id`
 *   (forge ULID lex ordering). Out-of-order retries become no-ops.
 * - Errors throw so the workflow runtime retries the step with backoff.
 */
import {WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep} from "cloudflare:workers";
import {sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "./drizzle/schema";

/* -------------------------------------------------------------------------- */
/* Event payloads                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Common envelope fields on every projection event. `eventId` is a forge ULID
 * that doubles as the workflow instance id (idempotent on retry) and the
 * convergence guard column on the target MV row.
 */
interface ProjectionEventBase {
	eventId: string;
}

export interface TermChangedEvent extends ProjectionEventBase {
	kind: "TermChanged";
	slug: string;
	title: string;
	definitionCount: number;
	totalScore: number;
	topDefinitionId: string | null;
	excerpt: string | null;
	firstAt: number;
	lastActivityAt: number;
	lastEditAt: number;
}

export interface DefinitionAddedEvent extends ProjectionEventBase {
	kind: "DefinitionAdded";
	definitionId: string;
	authorId: string;
	authorName: string;
	termSlug: string;
	termTitle: string;
	bodyExcerpt: string;
	score: number;
	createdAt: number;
}

export interface DefinitionEditedEvent extends ProjectionEventBase {
	kind: "DefinitionEdited";
	definitionId: string;
	bodyExcerpt: string;
	updatedAt: number;
}

export interface DefinitionDeletedEvent extends ProjectionEventBase {
	kind: "DefinitionDeleted";
	definitionId: string;
	deletedAt: number;
}

export interface PostChangedEvent extends ProjectionEventBase {
	kind: "PostChanged";
	postId: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	bodyExcerpt: string | null;
	authorId: string;
	authorName: string;
	tags: string[];
	score: number;
	commentCount: number;
	hotScore: number;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
}

export interface PostDeletedEvent extends ProjectionEventBase {
	kind: "PostDeleted";
	postId: string;
	deletedAt: number;
}

export interface CommentAddedEvent extends ProjectionEventBase {
	kind: "CommentAdded";
	commentId: string;
	authorId: string;
	authorName: string;
	postId: string;
	postTitle: string;
	bodyExcerpt: string;
	score: number;
	createdAt: number;
}

export interface CommentChangedEvent extends ProjectionEventBase {
	kind: "CommentChanged";
	commentId: string;
	score: number;
	updatedAt: number;
}

export interface CommentEditedEvent extends ProjectionEventBase {
	kind: "CommentEdited";
	commentId: string;
	bodyExcerpt: string;
	updatedAt: number;
}

export interface CommentDeletedEvent extends ProjectionEventBase {
	kind: "CommentDeleted";
	commentId: string;
	hasReplies: boolean;
	deletedAt: number;
}

export interface VoteRecordedEvent extends ProjectionEventBase {
	kind: "VoteRecorded";
	userId: string;
	targetKind: "definition" | "post" | "comment";
	targetId: string;
	// Producer's authoritative author for karma adjustment.
	targetAuthorId: string;
	// `true` = vote was cast, `false` = vote was retracted.
	value: boolean;
	createdAt: number;
}

export interface SozlukStatsChangedEvent extends ProjectionEventBase {
	kind: "SozlukStatsChanged";
	deltaTerms: number;
	deltaDefinitions: number;
	deltaAuthors: number;
	updatedAt: number;
}

export interface PanoStatsChangedEvent extends ProjectionEventBase {
	kind: "PanoStatsChanged";
	deltaPosts: number;
	deltaComments: number;
	deltaAuthors: number;
	updatedAt: number;
}

export interface UserProfileChangedEvent extends ProjectionEventBase {
	kind: "UserProfileChanged";
	userId: string;
	// NULL when the user hasn't completed the bootstrap step yet; backfill
	// events on migration emit NULL for existing users without usernames. Once
	// set on Pasaport's user table the value is immutable.
	username: string | null;
	displayName: string | null;
	image: string | null;
	updatedAt: number;
}

export type ProjectionEvent =
	| TermChangedEvent
	| DefinitionAddedEvent
	| DefinitionEditedEvent
	| DefinitionDeletedEvent
	| PostChangedEvent
	| PostDeletedEvent
	| CommentAddedEvent
	| CommentChangedEvent
	| CommentEditedEvent
	| CommentDeletedEvent
	| VoteRecordedEvent
	| SozlukStatsChangedEvent
	| PanoStatsChangedEvent
	| UserProfileChangedEvent;

/* -------------------------------------------------------------------------- */
/* Projection step bodies                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `TermChanged` projects per-term aggregates into `term_summary`. Convergent
 * overwrite guarded by `WHERE last_event_id < excluded.last_event_id` (forge
 * ULID lex ordering — out-of-order retries become no-ops).
 *
 * `sozluk_stats` totals are touched as part of the same step: we delta the
 * `total_terms` row only on first-time inserts (existing slug → no-op on the
 * delta). `total_definitions` is recomputed from the event payload's
 * authoritative count for this term, so we apply the delta against the
 * previous row's `definition_count`. `total_authors` waits for T4
 * (`DefinitionAdded` knows authors); seed runs through here without bumping
 * authors since the seed author (`kampus`) is denormalized everywhere.
 */
async function projectTermChanged(env: Env, e: TermChangedEvent): Promise<void> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const firstLetter = e.slug.charAt(0).toLowerCase();

	const previous = await db
		.select({
			definitionCount: schema.termSummary.definitionCount,
			lastEventId: schema.termSummary.lastEventId,
		})
		.from(schema.termSummary)
		.where(sql`${schema.termSummary.slug} = ${e.slug}`)
		.limit(1);
	const previousRow = previous[0];

	const result = await env.PHOENIX_DB.prepare(
		`INSERT INTO term_summary (
			slug, title, first_letter, definition_count, total_score,
			excerpt, top_definition_id, first_at, last_activity_at,
			last_edit_at, last_event_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(slug) DO UPDATE SET
			title             = excluded.title,
			definition_count  = excluded.definition_count,
			total_score       = excluded.total_score,
			excerpt           = excluded.excerpt,
			top_definition_id = excluded.top_definition_id,
			first_at          = excluded.first_at,
			last_activity_at  = excluded.last_activity_at,
			last_edit_at      = excluded.last_edit_at,
			last_event_id     = excluded.last_event_id
		WHERE term_summary.last_event_id < excluded.last_event_id`,
	)
		.bind(
			e.slug,
			e.title,
			firstLetter,
			e.definitionCount,
			e.totalScore,
			e.excerpt,
			e.topDefinitionId,
			e.firstAt > 0 ? Math.floor(e.firstAt / 1000) : null,
			Math.floor(e.lastActivityAt / 1000),
			e.lastEditAt > 0 ? Math.floor(e.lastEditAt / 1000) : null,
			e.eventId,
		)
		.run();

	// If the guard rejected the upsert (out-of-order retry), bail — no
	// stats delta either.
	if (result.meta.changes === 0) return;

	const isNewTerm = !previousRow;
	const previousDefinitionCount = previousRow?.definitionCount ?? 0;
	const definitionDelta = e.definitionCount - previousDefinitionCount;
	const termDelta = isNewTerm ? 1 : 0;

	if (termDelta === 0 && definitionDelta === 0) return;

	const updatedAt = Math.floor(e.lastActivityAt / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO sozluk_stats (id, total_definitions, total_terms, total_authors, updated_at)
		VALUES (1, ?, ?, 0, ?)
		ON CONFLICT(id) DO UPDATE SET
			total_definitions = sozluk_stats.total_definitions + ?,
			total_terms       = sozluk_stats.total_terms + ?,
			updated_at        = ?`,
	)
		.bind(Math.max(0, definitionDelta), termDelta, updatedAt, definitionDelta, termDelta, updatedAt)
		.run();
}

/**
 * `PostChanged` projects per-post aggregates into `post_summary`. Convergent
 * overwrite guarded by `WHERE last_event_id < excluded.last_event_id` (forge
 * ULID lex ordering).
 *
 * `pano_stats` totals are touched as part of the same step: we delta the
 * `total_posts` row only on first-time inserts (existing post → no-op on the
 * delta). `total_comments` is recomputed from the event payload's authoritative
 * `commentCount` for this post, so we apply the delta against the previous
 * row's `comment_count`. `total_authors` waits for T13 (UserProfileChanged).
 */
async function projectPostChanged(env: Env, e: PostChangedEvent): Promise<void> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const tagsCsv = e.tags.join(",");

	const previous = await db
		.select({
			commentCount: schema.postSummary.commentCount,
			lastEventId: schema.postSummary.lastEventId,
		})
		.from(schema.postSummary)
		.where(sql`${schema.postSummary.id} = ${e.postId}`)
		.limit(1);
	const previousRow = previous[0];

	const result = await env.PHOENIX_DB.prepare(
		`INSERT INTO post_summary (
			id, slug, title, url, host, body_excerpt, author_id, author_name,
			tags, score, comment_count, hot_score, created_at, updated_at,
			last_activity_at, deleted_at, last_event_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
		ON CONFLICT(id) DO UPDATE SET
			slug             = excluded.slug,
			title            = excluded.title,
			url              = excluded.url,
			host             = excluded.host,
			body_excerpt     = excluded.body_excerpt,
			author_id        = excluded.author_id,
			author_name      = excluded.author_name,
			tags             = excluded.tags,
			score            = excluded.score,
			comment_count    = excluded.comment_count,
			hot_score        = excluded.hot_score,
			updated_at       = excluded.updated_at,
			last_activity_at = excluded.last_activity_at,
			last_event_id    = excluded.last_event_id
		WHERE post_summary.last_event_id < excluded.last_event_id`,
	)
		.bind(
			e.postId,
			e.slug ?? null,
			e.title,
			e.url ?? null,
			e.host ?? null,
			e.bodyExcerpt ?? null,
			e.authorId,
			e.authorName,
			tagsCsv,
			e.score,
			e.commentCount,
			e.hotScore,
			Math.floor(e.createdAt / 1000),
			Math.floor(e.updatedAt / 1000),
			Math.floor(e.lastActivityAt / 1000),
			e.eventId,
		)
		.run();

	// If the guard rejected the upsert (out-of-order retry), bail — no
	// stats delta either.
	if (result.meta.changes === 0) return;

	const isNewPost = !previousRow;
	const previousCommentCount = previousRow?.commentCount ?? 0;
	const commentDelta = e.commentCount - previousCommentCount;
	const postDelta = isNewPost ? 1 : 0;

	if (postDelta === 0 && commentDelta === 0) return;

	const updatedAt = Math.floor(e.lastActivityAt / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO pano_stats (id, total_posts, total_comments, total_authors, updated_at)
		VALUES (1, ?, ?, 0, ?)
		ON CONFLICT(id) DO UPDATE SET
			total_posts    = pano_stats.total_posts + ?,
			total_comments = pano_stats.total_comments + ?,
			updated_at     = ?`,
	)
		.bind(postDelta, Math.max(0, commentDelta), updatedAt, postDelta, commentDelta, updatedAt)
		.run();
}

/**
 * `DefinitionAdded` writes a denormalized `definition_view` row used by the
 * profile contribution feed (T14). The row carries the term slug + title so
 * the feed renders without RPCing back into `SozlukTerm`. Convergent overwrite
 * guarded by `WHERE last_event_id < excluded.last_event_id` (idempotent on
 * retry, monotonic on out-of-order delivery).
 *
 * Edits/deletes land in T6 via separate `DefinitionEdited` / `DefinitionDeleted`
 * steps; this step only owns the initial insert.
 */
async function projectDefinitionAdded(env: Env, e: DefinitionAddedEvent): Promise<void> {
	const createdAt = Math.floor(e.createdAt / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO definition_view (
			id, author_id, author_name, term_slug, term_title,
			body_excerpt, score, created_at, updated_at, deleted_at, last_event_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
		ON CONFLICT(id) DO UPDATE SET
			body_excerpt  = excluded.body_excerpt,
			score         = excluded.score,
			updated_at    = excluded.updated_at,
			last_event_id = excluded.last_event_id
		WHERE definition_view.last_event_id < excluded.last_event_id`,
	)
		.bind(
			e.definitionId,
			e.authorId,
			e.authorName,
			e.termSlug,
			e.termTitle,
			e.bodyExcerpt,
			e.score,
			createdAt,
			createdAt,
			e.eventId,
		)
		.run();
}

/**
 * `VoteRecorded` updates the cross-product MV state for an upvote/retract:
 *
 * - `user_vote`: presence-only row keyed by (user_id, target_kind, target_id).
 *   Inserted on `value: true`, deleted on `value: false`. There's no value
 *   column (MVP is up-only voting).
 * - `user_profile.total_karma`: bumped +1 on cast, -1 on retract for the
 *   target's *author* (NOT the voter). The producer side is authoritative on
 *   `targetAuthorId` so the projection doesn't have to RPC back into the
 *   per-entity DO to figure out the author.
 *
 * Idempotency: the user_vote write uses INSERT OR IGNORE so retries don't
 * double-count karma. The retract path's DELETE returns `meta.changes` so we
 * only adjust karma when a row actually went away. This makes the step safe
 * to retry (workflow runtime guarantee) without a per-event guard column —
 * the (user, target) PK is the convergence guard for the user_vote row;
 * `meta.changes` is the convergence guard for the karma side effect.
 */
async function projectVoteRecorded(env: Env, e: VoteRecordedEvent): Promise<void> {
	const createdAt = Math.floor(e.createdAt / 1000);
	const updatedAt = createdAt;

	if (e.value) {
		// Cast vote: INSERT row; only bump karma if the row was actually new.
		const result = await env.PHOENIX_DB.prepare(
			`INSERT OR IGNORE INTO user_vote (user_id, target_kind, target_id, created_at)
			VALUES (?, ?, ?, ?)`,
		)
			.bind(e.userId, e.targetKind, e.targetId, createdAt)
			.run();
		if (result.meta.changes === 0) return;

		// Bump karma on the target's author. If the user_profile row doesn't
		// exist yet (author hasn't bootstrapped), seed a minimal row so the
		// karma counter has something to live on; the bootstrap event will
		// fill in the username/display_name later.
		await env.PHOENIX_DB.prepare(
			`INSERT INTO user_profile (
				user_id, username, display_name, image,
				total_karma, definition_count, post_count, comment_count,
				updated_at, last_event_id
			) VALUES (?, NULL, NULL, NULL, 1, 0, 0, 0, ?, '')
			ON CONFLICT(user_id) DO UPDATE SET
				total_karma = user_profile.total_karma + 1,
				updated_at  = excluded.updated_at`,
		)
			.bind(e.targetAuthorId, updatedAt)
			.run();
	} else {
		// Retract vote: DELETE row; only decrement karma if a row went away.
		const result = await env.PHOENIX_DB.prepare(
			`DELETE FROM user_vote WHERE user_id = ? AND target_kind = ? AND target_id = ?`,
		)
			.bind(e.userId, e.targetKind, e.targetId)
			.run();
		if (result.meta.changes === 0) return;

		// Decrement karma on the target's author. Floor at 0 so retries can't
		// underflow if the cast event was lost (defensive — convergence
		// shouldn't drift, but a decrement on a missing row would return
		// changes=0 and silently no-op anyway).
		await env.PHOENIX_DB.prepare(
			`UPDATE user_profile SET
				total_karma = MAX(0, total_karma - 1),
				updated_at  = ?
			WHERE user_id = ?`,
		)
			.bind(updatedAt, e.targetAuthorId)
			.run();
	}
}

/**
 * `UserProfileChanged` projects per-user identity into `user_profile`. The
 * username column is the public handle (immutable once set on Pasaport, this
 * step only ever sees a valid value); display_name + image stay refreshable.
 *
 * Convergent overwrite guarded by `WHERE last_event_id < excluded.last_event_id`.
 * Counters (`total_karma`, `definition_count`, `post_count`, `comment_count`)
 * are owned by other projection steps (`VoteRecorded`, `DefinitionAdded`, …)
 * and are NOT touched here; first-time inserts default them to 0 and downstream
 * events apply deltas.
 */
async function projectUserProfileChanged(env: Env, e: UserProfileChangedEvent): Promise<void> {
	const updatedAt = Math.floor(e.updatedAt / 1000);

	// Username is immutable on Pasaport once set, so COALESCE preserves an
	// existing value if a stale backfill event (NULL username) arrives after
	// a bootstrap event (set username). Pair this with the last_event_id
	// guard for convergent ordering on display_name/image refreshes.
	await env.PHOENIX_DB.prepare(
		`INSERT INTO user_profile (
			user_id, username, display_name, image,
			total_karma, definition_count, post_count, comment_count,
			updated_at, last_event_id
		) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			username      = COALESCE(excluded.username, user_profile.username),
			display_name  = excluded.display_name,
			image         = excluded.image,
			updated_at    = excluded.updated_at,
			last_event_id = excluded.last_event_id
		WHERE user_profile.last_event_id < excluded.last_event_id`,
	)
		.bind(
			e.userId,
			e.username ?? null,
			e.displayName ?? null,
			e.image ?? null,
			updatedAt,
			e.eventId,
		)
		.run();
}

/* -------------------------------------------------------------------------- */
/* Workflow                                                                   */
/* -------------------------------------------------------------------------- */

export class PhoenixProjection extends WorkflowEntrypoint<Env, ProjectionEvent> {
	override async run(event: Readonly<WorkflowEvent<ProjectionEvent>>, step: WorkflowStep) {
		const e = event.payload;

		await step.do(`project-${e.kind}`, async () => {
			switch (e.kind) {
				// Sozluk
				case "TermChanged":
					return projectTermChanged(this.env, e);
				case "DefinitionAdded":
					return projectDefinitionAdded(this.env, e);
				case "DefinitionEdited":
					return;
				case "DefinitionDeleted":
					return;

				// Pano
				case "PostChanged":
					return projectPostChanged(this.env, e);
				case "PostDeleted":
					return;
				case "CommentAdded":
					return;
				case "CommentChanged":
					return;
				case "CommentEdited":
					return;
				case "CommentDeleted":
					return;

				// Cross-product
				case "VoteRecorded":
					return projectVoteRecorded(this.env, e);
				case "SozlukStatsChanged":
					return;
				case "PanoStatsChanged":
					return;
				case "UserProfileChanged":
					return projectUserProfileChanged(this.env, e);

				default: {
					// Exhaustiveness guard: TS will error here if a new event
					// kind is added to ProjectionEvent without a case above.
					const _exhaustive: never = e;
					throw new Error(`unknown projection event kind: ${JSON.stringify(_exhaustive)}`);
				}
			}
		});
	}
}
