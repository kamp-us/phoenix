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
	/** Author of the deleted post — surfaced for downstream user_profile stats. */
	authorId: string;
	deletedAt: number;
}

export interface CommentAddedEvent extends ProjectionEventBase {
	kind: "CommentAdded";
	commentId: string;
	authorId: string;
	authorName: string;
	postId: string;
	postTitle: string;
	/**
	 * Optional human-friendly post slug (null when the post doesn't have one).
	 * Carried denormalized so the profile contribution feed (T14) can link to
	 * the post without a per-row RPC.
	 */
	postSlug?: string | null;
	/**
	 * Parent comment id when this is a nested reply, `null` for top-level
	 * comments. The `comment_view` MV doesn't carry parent info today —
	 * the field is reserved for future tree views off the profile feed.
	 */
	parentId: string | null;
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
	postId: string;
	/**
	 * Parent comment id (null for top-level). Carried for parity with the
	 * per-DO read shape; not required by the current projection step but the
	 * cross-product profile feed (T14) uses it to walk reply chains.
	 */
	parentId: string | null;
	/**
	 * Author of the deleted comment — surfaced for downstream user_profile
	 * aggregates (e.g. comment_count decrement in T13/T14).
	 */
	authorId: string;
	/**
	 * Producer-computed: `true` iff the comment had at least one non-deleted
	 * child at delete time. Drives the projection's reply-aware tree rewrite:
	 * - `true` → UPDATE `comment_view` SET body_excerpt = '[silindi]', deleted_at = ?
	 * - `false` → DELETE FROM `comment_view` (row vanishes from the tree)
	 */
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
/* Stats recompute helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recompute the single-row `sozluk_stats` aggregate from the underlying view
 * tables. Cheap and convergent: three small COUNT queries against indexed
 * columns, then one UPSERT.
 *
 * - `total_terms` = COUNT(*) FROM term_summary
 * - `total_definitions` = COUNT(*) FROM definition_view WHERE deleted_at IS NULL
 * - `total_authors` = COUNT(DISTINCT author_id) FROM definition_view
 *                     WHERE deleted_at IS NULL
 *
 * Called by every projection step that writes to `term_summary` or
 * `definition_view`. Idempotent: out-of-order retries land at the same row.
 */
async function recomputeSozlukStats(env: Env, updatedAt: number): Promise<void> {
	const totalTerms = await env.PHOENIX_DB.prepare("SELECT COUNT(*) as n FROM term_summary").first<{
		n: number;
	}>();
	const totalDefs = await env.PHOENIX_DB.prepare(
		"SELECT COUNT(*) as n FROM definition_view WHERE deleted_at IS NULL",
	).first<{n: number}>();
	const totalAuthors = await env.PHOENIX_DB.prepare(
		"SELECT COUNT(DISTINCT author_id) as n FROM definition_view WHERE deleted_at IS NULL",
	).first<{n: number}>();

	await env.PHOENIX_DB.prepare(
		`INSERT INTO sozluk_stats (id, total_definitions, total_terms, total_authors, updated_at)
		VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			total_definitions = excluded.total_definitions,
			total_terms       = excluded.total_terms,
			total_authors     = excluded.total_authors,
			updated_at        = excluded.updated_at`,
	)
		.bind(totalDefs?.n ?? 0, totalTerms?.n ?? 0, totalAuthors?.n ?? 0, updatedAt)
		.run();
}

/**
 * Recompute the single-row `pano_stats` aggregate from the underlying view
 * tables. Same shape as `recomputeSozlukStats` — three COUNT queries + one
 * UPSERT. `total_authors` is the distinct author union across `post_summary`
 * and `comment_view` (same person posting AND commenting only counts once).
 *
 * Called by every projection step that writes to `post_summary` or
 * `comment_view`. Idempotent on retry.
 */
async function recomputePanoStats(env: Env, updatedAt: number): Promise<void> {
	const totalPosts = await env.PHOENIX_DB.prepare(
		"SELECT COUNT(*) as n FROM post_summary WHERE deleted_at IS NULL",
	).first<{n: number}>();
	const totalComments = await env.PHOENIX_DB.prepare(
		"SELECT COUNT(*) as n FROM comment_view WHERE deleted_at IS NULL",
	).first<{n: number}>();
	const totalAuthors = await env.PHOENIX_DB.prepare(
		`SELECT COUNT(DISTINCT author_id) as n FROM (
			SELECT author_id FROM post_summary WHERE deleted_at IS NULL
			UNION
			SELECT author_id FROM comment_view WHERE deleted_at IS NULL
		)`,
	).first<{n: number}>();

	await env.PHOENIX_DB.prepare(
		`INSERT INTO pano_stats (id, total_posts, total_comments, total_authors, updated_at)
		VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			total_posts    = excluded.total_posts,
			total_comments = excluded.total_comments,
			total_authors  = excluded.total_authors,
			updated_at     = excluded.updated_at`,
	)
		.bind(totalPosts?.n ?? 0, totalComments?.n ?? 0, totalAuthors?.n ?? 0, updatedAt)
		.run();
}

/* -------------------------------------------------------------------------- */
/* Projection step bodies                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `TermChanged` projects per-term aggregates into `term_summary`. Convergent
 * overwrite guarded by `WHERE last_event_id < excluded.last_event_id` (forge
 * ULID lex ordering — out-of-order retries become no-ops).
 *
 * `sozluk_stats` totals (`total_terms`, `total_definitions`, `total_authors`)
 * are recomputed via `recomputeSozlukStats` after the term row lands. The
 * recompute is cheap (three small COUNT queries against indexed columns) and
 * convergent regardless of event delivery order.
 */
async function projectTermChanged(env: Env, e: TermChangedEvent): Promise<void> {
	const firstLetter = e.slug.charAt(0).toLowerCase();

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
	// stats touch either.
	if (result.meta.changes === 0) return;

	await recomputeSozlukStats(env, Math.floor(e.lastActivityAt / 1000));
}

/**
 * `PostChanged` projects per-post aggregates into `post_summary`. Convergent
 * overwrite guarded by `WHERE last_event_id < excluded.last_event_id` (forge
 * ULID lex ordering).
 *
 * `pano_stats` totals are recomputed from the underlying view tables after the
 * post row lands. See `recomputePanoStats` for the recompute strategy.
 */
async function projectPostChanged(env: Env, e: PostChangedEvent): Promise<void> {
	const tagsCsv = e.tags.join(",");

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
	// stats touch either.
	if (result.meta.changes === 0) return;

	await recomputePanoStats(env, Math.floor(e.lastActivityAt / 1000));
}

/**
 * `PostDeleted` removes the post from `post_summary` entirely (the post
 * disappears from the feed per the PRD spec — vs. soft-stamping like
 * definitions). Also:
 * - Decrements `pano_stats.total_posts` and adjusts `total_comments` by the
 *   deleted row's `comment_count` so the landing counters stay honest.
 * - Deletes any `comment_view` rows whose `post_id` matches so the profile
 *   contribution feed doesn't reference an orphaned post (T14 reads).
 *
 * `user_vote` rows are intentionally LEFT in place — they're cross-product
 * (user × target) and cascade-deleting them would require iterating every
 * voter on the post. An orphan vote row pointing at a no-longer-existent
 * post is a tolerable inconsistency: the `myVote` resolver only reads on
 * detail / list paths where the post must exist to be rendered.
 *
 * Convergence: the row removal is unconditional (`DELETE WHERE id = ?`) — once
 * a delete event lands, any subsequent `PostChanged` event must lose the
 * `last_event_id` guard on a missing row (the upsert re-creates the row).
 * Order: producer-side outbox FIFO + workflow.create's idempotency on event
 * id keeps a delete-after-create chain serialized. A stale `PostChanged`
 * arriving after the delete would resurrect the row; if this becomes a real
 * concern, a `deleted_at` stamp on `post_summary` (already present in the
 * column list) could gate future upserts. For now the producer doesn't emit
 * `PostChanged` after `PostDeleted` (the Agent's `editPost` / vote paths read
 * `deleted_at` first and bail), so resurrection isn't reachable.
 */
async function projectPostDeleted(env: Env, e: PostDeletedEvent): Promise<void> {
	const result = await env.PHOENIX_DB.prepare(`DELETE FROM post_summary WHERE id = ?`)
		.bind(e.postId)
		.run();

	// Cascade: drop any comment_view rows for comments on this post so the
	// profile feed doesn't reference an orphan post. Safe to run even when
	// nothing matches; D1's DELETE returns changes=0 in that case.
	await env.PHOENIX_DB.prepare(`DELETE FROM comment_view WHERE post_id = ?`).bind(e.postId).run();

	// If the post row was already gone (idempotent retry), don't double-touch
	// pano_stats. The DELETE above returned changes=0; nothing else to do.
	if (result.meta.changes === 0) return;

	await recomputePanoStats(env, Math.floor(e.deletedAt / 1000));
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
	const result = await env.PHOENIX_DB.prepare(
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

	// Out-of-order retry on the same id is a no-op; only recompute when the
	// row actually changed (insert or convergent update).
	if (result.meta.changes === 0) return;
	await recomputeSozlukStats(env, createdAt);
}

/**
 * `DefinitionEdited` refreshes the `definition_view.body_excerpt` and
 * `updated_at` for the row matching `definitionId`. Convergent overwrite
 * guarded by `WHERE last_event_id < excluded.last_event_id` (forge ULID
 * lex ordering — out-of-order retries become no-ops).
 *
 * The row is created by `DefinitionAdded` (T4); this step only updates the
 * editable columns. If the row doesn't exist yet (the projection arrived
 * before the `DefinitionAdded` event landed — possible under workflow
 * out-of-order delivery), the UPDATE is a no-op and the eventual
 * `DefinitionAdded` retry will write the latest body via its own guard.
 */
async function projectDefinitionEdited(env: Env, e: DefinitionEditedEvent): Promise<void> {
	const updatedAt = Math.floor(e.updatedAt / 1000);
	await env.PHOENIX_DB.prepare(
		`UPDATE definition_view SET
			body_excerpt  = ?,
			updated_at    = ?,
			last_event_id = ?
		WHERE id = ? AND last_event_id < ?`,
	)
		.bind(e.bodyExcerpt, updatedAt, e.eventId, e.definitionId, e.eventId)
		.run();
}

/**
 * `DefinitionDeleted` stamps `deleted_at` on the matching `definition_view`
 * row so the profile feed (T14) filters it out via `WHERE deleted_at IS NULL`.
 * Convergent overwrite guarded by `last_event_id`. The per-term DO's
 * `getTerm()` already filters deleted rows from the on-page list (T2 contract);
 * this step only owns the `definition_view` MV side.
 */
async function projectDefinitionDeleted(env: Env, e: DefinitionDeletedEvent): Promise<void> {
	const deletedAt = Math.floor(e.deletedAt / 1000);
	const result = await env.PHOENIX_DB.prepare(
		`UPDATE definition_view SET
			deleted_at    = ?,
			updated_at    = ?,
			last_event_id = ?
		WHERE id = ? AND last_event_id < ?`,
	)
		.bind(deletedAt, deletedAt, e.eventId, e.definitionId, e.eventId)
		.run();
	if (result.meta.changes === 0) return;
	await recomputeSozlukStats(env, deletedAt);
}

/**
 * `CommentAdded` writes a denormalized `comment_view` row used by the
 * profile contribution feed (T14). The row carries the post id + title so
 * the feed renders without RPCing back into `PanoPost`. Convergent overwrite
 * guarded by `WHERE last_event_id < excluded.last_event_id` (forge ULID lex
 * ordering — idempotent on retry, monotonic on out-of-order delivery).
 *
 * The `commentCount` bump on `post_summary` is owned by the sibling
 * `PostChanged` event that the producer emits in the same `transactionSync`
 * — keeping this step a dumb one-table upsert.
 *
 * Edits / deletes land in T12 via separate `CommentEdited` / `CommentDeleted`
 * steps; this step only owns the initial insert.
 */
async function projectCommentAdded(env: Env, e: CommentAddedEvent): Promise<void> {
	const createdAt = Math.floor(e.createdAt / 1000);
	const result = await env.PHOENIX_DB.prepare(
		`INSERT INTO comment_view (
			id, author_id, author_name, post_id, post_title,
			body_excerpt, score, created_at, updated_at, deleted_at, last_event_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
		ON CONFLICT(id) DO UPDATE SET
			body_excerpt  = excluded.body_excerpt,
			score         = excluded.score,
			updated_at    = excluded.updated_at,
			last_event_id = excluded.last_event_id
		WHERE comment_view.last_event_id < excluded.last_event_id`,
	)
		.bind(
			e.commentId,
			e.authorId,
			e.authorName,
			e.postId,
			e.postTitle,
			e.bodyExcerpt,
			e.score,
			createdAt,
			createdAt,
			e.eventId,
		)
		.run();
	if (result.meta.changes === 0) return;
	await recomputePanoStats(env, createdAt);
}

/**
 * `CommentChanged` refreshes the `comment_view.score` + `updated_at` for the
 * comment row matching `commentId`. Convergent overwrite guarded by
 * `WHERE last_event_id < ?` (forge ULID lex ordering — out-of-order retries
 * become no-ops).
 *
 * The row is created by `CommentAdded` (T10); this step only updates the
 * score column. If the row doesn't exist yet (the projection arrived before
 * the `CommentAdded` event landed — possible under workflow out-of-order
 * delivery), the UPDATE is a no-op and the eventual `CommentAdded` retry will
 * write the row via its own guard. The vote-table truth lives in the per-post
 * DO; this MV side is for the cross-product profile feed.
 */
async function projectCommentChanged(env: Env, e: CommentChangedEvent): Promise<void> {
	const updatedAt = Math.floor(e.updatedAt / 1000);
	await env.PHOENIX_DB.prepare(
		`UPDATE comment_view SET
			score         = ?,
			updated_at    = ?,
			last_event_id = ?
		WHERE id = ? AND last_event_id < ?`,
	)
		.bind(e.score, updatedAt, e.eventId, e.commentId, e.eventId)
		.run();
}

/**
 * `CommentEdited` refreshes `comment_view.body_excerpt` + `updated_at` after
 * an author-initiated body edit (T12). Convergent overwrite guarded by
 * `WHERE last_event_id < ?` (forge ULID lex ordering — out-of-order retries
 * become no-ops). Score is owned by `CommentChanged` so it isn't touched
 * here.
 */
async function projectCommentEdited(env: Env, e: CommentEditedEvent): Promise<void> {
	const updatedAt = Math.floor(e.updatedAt / 1000);
	await env.PHOENIX_DB.prepare(
		`UPDATE comment_view SET
			body_excerpt  = ?,
			updated_at    = ?,
			last_event_id = ?
		WHERE id = ? AND last_event_id < ?`,
	)
		.bind(e.bodyExcerpt, updatedAt, e.eventId, e.commentId, e.eventId)
		.run();
}

/**
 * `CommentDeleted` is reply-aware (T12):
 *
 * - **Has live replies** (`hasReplies: true`) → UPDATE `comment_view` SET
 *   `body_excerpt = '[silindi]'`, `deleted_at = now`. The row stays so the
 *   profile contribution feed and any future tree views can preserve thread
 *   structure (`parent_id` chains rooted at this comment continue to render).
 * - **Leaf** (`hasReplies: false`) → DELETE the `comment_view` row entirely;
 *   the comment vanishes from the tree.
 *
 * The producer (`PanoPost.deleteComment`) computes `hasReplies` against the
 * per-post DO sqlite (the source of truth for `parent_id`) inside the same
 * `transactionSync` as the soft-delete UPDATE, so the decision can never
 * race against a concurrent reply landing on the same comment.
 *
 * Convergence guard (`last_event_id < ?`) is on the UPDATE branch only; the
 * DELETE branch is naturally idempotent (re-deleting a missing row is a
 * no-op via `WHERE id = ?`).
 */
async function projectCommentDeleted(env: Env, e: CommentDeletedEvent): Promise<void> {
	const deletedAt = Math.floor(e.deletedAt / 1000);
	if (e.hasReplies) {
		const result = await env.PHOENIX_DB.prepare(
			`UPDATE comment_view SET
				body_excerpt  = ?,
				deleted_at    = ?,
				updated_at    = ?,
				last_event_id = ?
			WHERE id = ? AND last_event_id < ?`,
		)
			.bind("[silindi]", deletedAt, deletedAt, e.eventId, e.commentId, e.eventId)
			.run();
		if (result.meta.changes === 0) return;
		await recomputePanoStats(env, deletedAt);
		return;
	}
	const result = await env.PHOENIX_DB.prepare(`DELETE FROM comment_view WHERE id = ?`)
		.bind(e.commentId)
		.run();
	if (result.meta.changes === 0) return;
	await recomputePanoStats(env, deletedAt);
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
					return projectDefinitionEdited(this.env, e);
				case "DefinitionDeleted":
					return projectDefinitionDeleted(this.env, e);

				// Pano
				case "PostChanged":
					return projectPostChanged(this.env, e);
				case "PostDeleted":
					return projectPostDeleted(this.env, e);
				case "CommentAdded":
					return projectCommentAdded(this.env, e);
				case "CommentChanged":
					return projectCommentChanged(this.env, e);
				case "CommentEdited":
					return projectCommentEdited(this.env, e);
				case "CommentDeleted":
					return projectCommentDeleted(this.env, e);

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
