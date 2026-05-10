/**
 * Per-post Agent DO. Addressed by `idFromName(postId)` — one instance per post.
 *
 * Lineage:
 * - ADR 0005 — per-coordination-atom sharding (`PanoPost` per post).
 * - ADR 0006 — extends `Agent<Env, PostState>`; typed state + WebSocket sync
 *   + named schedules.
 * - ADR 0007 — outbox + Workflows + D1 view layer; mutation methods land in
 *   later tasks (T7–T12) with the producer pattern (atomic outbox + `this.queue`
 *   + `onStart` reconciliation).
 *
 * T3 scope: read paths + admin seed paths. The mutation surface (`submitPost`,
 * `voteOnPost`, `addComment`, …) lands in T7+. The outbox table and
 * reconciliation skeletons exist now so T7 can wire mutations without another
 * schema migration.
 */
import {id} from "@usirin/forge";
import {Agent} from "agents";
import {asc, desc, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./post-drizzle/migrations/migrations";
import * as schema from "./post-drizzle/schema";

/* -------------------------------------------------------------------------- */
/* State + read shapes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Canonical aggregates kept on `Agent.state`. Mutation methods recompute and
 * `setState({...})` after each `transactionSync`. The values here are the
 * only thing WebSocket-connected clients see live; they MUST always reflect
 * the underlying sqlite truth.
 *
 * `lastEventId` is set on every state-changing mutation; it's the convergence
 * guard column for `post_summary` in `PHOENIX_DB`.
 */
export interface PostState {
	title: string;
	host: string | null;
	score: number;
	commentCount: number;
	hotScore: number;
	lastActivityAt: number;
	lastEventId: string;
}

const INITIAL_STATE: PostState = {
	title: "",
	host: null,
	score: 0,
	commentCount: 0,
	hotScore: 0,
	lastActivityAt: 0,
	lastEventId: "",
};

/**
 * Read shape returned by `getPost()`. Keeps the GraphQL `Post` type a dumb
 * projection — the existing `PanoPostDetail` query asks for these fields
 * directly.
 */
export interface PostTagRow {
	kind: string;
	label: string;
}

export interface PostPage {
	id: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	author: string;
	/**
	 * Pasaport user id of the author. Powers the frontend's
	 * "is the current user the author?" check that gates edit / delete
	 * affordances (T9). Mirrors `Definition.authorId` from T6.
	 */
	authorId: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	/**
	 * Last-mutation timestamp; matches `post_meta.updated_at`. Mirrors
	 * `Definition.updatedAt` (T6). Used by the SPA's "düzenlendi" indicator
	 * when `updatedAt > createdAt + 60s` (T17).
	 */
	updatedAt: Date;
	tags: PostTagRow[];
}

export interface CommentRow {
	id: string;
	parentId: string | null;
	author: string;
	/**
	 * Pasaport user id of the comment's author. Powers the frontend's
	 * "is the current user the author?" check that gates edit / delete
	 * affordances (T12). Mirrors `Definition.authorId` (T6) and
	 * `Post.authorId` (T9).
	 */
	authorId: string;
	body: string;
	score: number;
	createdAt: Date;
	/**
	 * Last-mutation timestamp; matches `comment.updated_at`. Powers the SPA's
	 * "düzenlendi" indicator when `updatedAt > createdAt + 60s` (T17).
	 */
	updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Submit-post shapes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validation error thrown by `submitPost`. The GraphQL resolver catches this
 * and surfaces a stable `code` extension so the SPA can localize without
 * parsing free-text messages.
 */
export class PostValidationError extends Error {
	constructor(
		readonly code:
			| "title_required"
			| "title_too_long"
			| "url_invalid"
			| "body_too_long"
			| "tags_required"
			| "tag_invalid",
		message: string,
	) {
		super(message);
		this.name = "PostValidationError";
	}
}

/** Title cap (per PRD: ≤ 200 chars). */
export const POST_TITLE_MAX = 200;
/** Body cap (per PRD: ≤ 10 000 chars on submitPost). */
export const POST_BODY_MAX = 10_000;
/**
 * The fixed tag enum for Pano posts (per PRD). The producer-side check is
 * defense-in-depth: the GraphQL resolver enforces the same set, but the Agent
 * is the durability boundary, so it re-validates.
 *
 * Stored on `post_summary.tags` as comma-separated values; rendered in Turkish
 * via `postSummaryReader`'s `TAG_LABELS`.
 */
export const ALLOWED_POST_TAG_KINDS = ["göster", "tartışma", "soru", "söylenme", "meta"] as const;

export type AllowedPostTagKind = (typeof ALLOWED_POST_TAG_KINDS)[number];

export interface SubmitPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	tags: ReadonlyArray<{kind: string; label?: string | undefined}>;
	authorId: string;
	authorName: string;
}

export interface SubmitPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Vote shapes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by `voteOnPost` / `retractPostVote` when no `post_meta` row exists in
 * this DO yet (the resolver routed by `idFromName(postId)` for an id no one
 * ever wrote to). The resolver translates this to a GraphQL error with
 * `code: 'POST_NOT_FOUND'`.
 */
export class PostNotFoundError extends Error {
	readonly code = "post_not_found" as const;
	constructor(postId: string) {
		super(`post ${postId} not found`);
		this.name = "PostNotFoundError";
	}
}

export interface VoteOnPostInput {
	voterId: string;
}

/**
 * Result returned by both `voteOnPost` and `retractPostVote`. Mirrors the
 * post-write state of the post so the GraphQL resolver can reconstruct a
 * `Post` payload without a round-trip read.
 *
 * `myVote` is set authoritatively from the agent's vote-table state so the
 * resolver doesn't have to await the cross-product `user_vote` MV projection
 * (which races with the GraphQL response). After a vote, `myVote = 1`; after
 * a retract, `myVote = null`. Idempotent no-ops preserve the existing state.
 */
export interface VoteOnPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	hotScore: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
	/** `1` if the voter has voted on this post (post-write), `null` otherwise. */
	myVote: number | null;
	/** `true` if the vote row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Vote-on-comment shapes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by `voteOnComment` / `retractCommentVote` when the target comment id
 * doesn't exist in this DO (or is soft-deleted). Mirrors `PostNotFoundError`.
 */
export class CommentNotFoundError extends Error {
	readonly code = "comment_not_found" as const;
	constructor(commentId: string) {
		super(`comment ${commentId} not found`);
		this.name = "CommentNotFoundError";
	}
}

export interface VoteOnCommentInput {
	commentId: string;
	voterId: string;
}

/**
 * Result returned by both `voteOnComment` and `retractCommentVote`. Mirrors
 * the post-write state of the comment so the GraphQL resolver can return a
 * full `Comment` payload without a round-trip read.
 *
 * `myVote` is stamped authoritatively from the comment_vote table state so
 * the `Comment.myVote` field doesn't race against the cross-product MV
 * projection (same pattern as `VoteOnPostResult.myVote` in T8).
 */
export interface VoteOnCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	/** `1` if the voter has voted on this comment (post-write), `null` otherwise. */
	myVote: number | null;
	/** `true` if the vote row state changed; `false` on idempotent no-op. */
	changed: boolean;
}

/* -------------------------------------------------------------------------- */
/* Add-comment shapes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validation error thrown by `addComment`. The GraphQL resolver catches this
 * and surfaces a stable `code` extension so the SPA can localize without
 * parsing free-text messages.
 *
 * `parent_not_found` is the same-post invariant: a nested reply must reference
 * an existing non-deleted comment in this DO. Because the comment table lives
 * inside the per-post DO, the same-post check is trivially enforced by routing
 * — we only need to confirm the row exists locally.
 */
export class CommentValidationError extends Error {
	constructor(
		readonly code: "body_required" | "body_too_long" | "parent_not_found",
		message: string,
	) {
		super(message);
		this.name = "CommentValidationError";
	}
}

/** Comment body cap (per PRD: ≤ 5 000 chars). */
export const COMMENT_BODY_MAX = 5_000;

export interface AddCommentInput {
	authorId: string;
	authorName: string;
	body: string;
	/** Optional parent comment id for nested replies. Must reference an
	 *  existing non-deleted comment in this DO. */
	parentId?: string | null | undefined;
}

export interface AddCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	commentCount: number;
	createdAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Comment edit / delete shapes                                                */
/* -------------------------------------------------------------------------- */

/**
 * Placeholder body rendered in place of a soft-deleted comment that still has
 * non-deleted replies (T12). Used by both the per-DO `listComments` read and
 * the cross-product `comment_view` projection so the tree shape is identical
 * across both surfaces.
 */
export const SILINDI_PLACEHOLDER = "[silindi]";

/**
 * Thrown by `editComment` / `deleteComment` when the calling user is not the
 * author of the target comment. The GraphQL resolver translates this to a
 * clean error with `code: 'UNAUTHORIZED'`. Mirrors
 * `UnauthorizedPostMutationError` (T9).
 */
export class UnauthorizedCommentMutationError extends Error {
	readonly code = "unauthorized" as const;
	constructor(commentId: string) {
		super(`not authorized to mutate comment ${commentId}`);
		this.name = "UnauthorizedCommentMutationError";
	}
}

export interface EditCommentInput {
	commentId: string;
	/** Calling user's id — used for the ownership check. */
	actorId: string;
	body: string;
}

export interface EditCommentResult {
	commentId: string;
	postId: string;
	parentId: string | null;
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface DeleteCommentInput {
	commentId: string;
	/** Calling user's id — used for the ownership check. */
	actorId: string;
}

export interface DeleteCommentResult {
	commentId: string;
	/** `true` if the row was soft-deleted; `false` on idempotent no-op. */
	deleted: boolean;
	/**
	 * `true` when the comment had at least one non-deleted child at delete
	 * time → tree-preserving `[silindi]` placeholder; `false` when the
	 * comment was a leaf → fully removed from the tree.
	 */
	hasReplies: boolean;
}

/* -------------------------------------------------------------------------- */
/* Edit / Delete shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by `editPost` / `deletePost` when the calling user is not the
 * author of the target post. The GraphQL resolver translates this to a clean
 * error with `code: 'UNAUTHORIZED'` so the SPA can surface a typed error.
 * Mirrors `UnauthorizedDefinitionMutationError` (T6) — same wire shape across
 * the RPC boundary (workerd drops class identity; `name` survives).
 */
export class UnauthorizedPostMutationError extends Error {
	readonly code = "unauthorized" as const;
	constructor(postId: string) {
		super(`not authorized to mutate post ${postId}`);
		this.name = "UnauthorizedPostMutationError";
	}
}

export interface EditPostInput {
	/** Calling user's id — used for the ownership check. */
	actorId: string;
	/** New title (if provided; at least one of title/body required). */
	title?: string | undefined;
	/** New body (if provided; at least one of title/body required). */
	body?: string | undefined;
}

export interface EditPostResult {
	postId: string;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	authorId: string;
	authorName: string;
	score: number;
	hotScore: number;
	commentCount: number;
	tags: PostTagRow[];
	createdAt: Date;
	updatedAt: Date;
}

export interface DeletePostInput {
	/** Calling user's id — used for the ownership check. */
	actorId: string;
}

export interface DeletePostResult {
	postId: string;
	/** `true` if the row was soft-deleted; `false` on idempotent no-op. */
	deleted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Admin / seed shapes                                                         */
/* -------------------------------------------------------------------------- */

export interface SeedTagInput {
	kind: string;
	label: string;
}

export interface SeedCommentInput {
	authorId: string;
	authorName: string;
	body: string;
	score?: number | undefined;
	/** Index into the seed comments array. `null` / undefined = top-level. */
	parentIdx?: number | undefined;
}

export interface SeedPostInput {
	title: string;
	url?: string | undefined;
	body?: string | undefined;
	authorId: string;
	authorName: string;
	score: number;
	tags: SeedTagInput[];
	comments: SeedCommentInput[];
}

export interface SeedPostResult {
	created: boolean;
	insertedComments: number;
	insertedTags: number;
}

/* -------------------------------------------------------------------------- */
/* HN-style hot score                                                          */
/* -------------------------------------------------------------------------- */

/**
 * HN-style hot score: `score / (hours_old + 2)^1.8`. Multiplied by 1000 and
 * floored so the persisted column stays an integer (D1 indexes integers
 * cheaper than floats and the relative ordering is what matters).
 */
function computeHotScore(score: number, createdAtMs: number, nowMs: number): number {
	const hoursOld = Math.max(0, (nowMs - createdAtMs) / 3_600_000);
	const denom = (hoursOld + 2) ** 1.8;
	return Math.floor((score * 1000) / denom);
}

/* -------------------------------------------------------------------------- */
/* Agent                                                                       */
/* -------------------------------------------------------------------------- */

export class PanoPost extends Agent<Env, PostState> {
	override initialState: PostState = INITIAL_STATE;

	db = drizzle(this.ctx.storage, {schema});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	/* -------- Lifecycle -------------------------------------------------- */

	/**
	 * Periodic outbox reconciliation (5 min) per ADR 0007. Plus a one-shot
	 * reconcile on hydration so any rows left over from a worker that died
	 * mid-flush get re-dispatched immediately. Mirrors `SozlukTerm.onStart`.
	 */
	override async onStart() {
		if (!(await this.getScheduleById("reconcile-outbox"))) {
			await this.scheduleEvery(300, "reconcileOutbox");
		}
		try {
			await this.reconcileOutbox();
		} catch (err) {
			console.error("[PanoPost.onStart] reconcileOutbox failed", err);
		}
	}

	/**
	 * Drain the outbox: for every row, dispatch the payload to
	 * `PHOENIX_PROJECTION.create`. On success delete the row; on failure
	 * leave it so the next pass re-queues. Oldest-first
	 * (`ORDER BY created_at ASC`) — forge ULID lex-ordering on `event_id`
	 * means convergence is consistent regardless of dispatch order, but
	 * older rows have spent the most time waiting, so flush them first.
	 */
	async reconcileOutbox(): Promise<void> {
		const rows = this.sql<{event_id: string; payload: string}>`
			SELECT event_id, payload FROM outbox ORDER BY created_at ASC
		`;
		if (rows.length === 0) return;

		for (const row of rows) {
			try {
				const payload = JSON.parse(row.payload);
				await this.env.PHOENIX_PROJECTION.create({
					id: row.event_id,
					params: payload,
				});
				this.sql`DELETE FROM outbox WHERE event_id = ${row.event_id}`;
			} catch (err) {
				console.error(`[PanoPost.reconcileOutbox] dispatch failed for ${row.event_id}`, err);
				// Leave the row; next reconcile pass will retry it.
			}
		}
	}

	/* -------- Reads ------------------------------------------------------ */

	/**
	 * Single post page read. Returns null when the post doesn't exist (no
	 * `post_meta` row yet — `idFromName(postId)` always lands on this DO,
	 * so a missing row means no one's written here yet). The post is also
	 * treated as missing once `deletedAt` is set (T9).
	 */
	async getPost(): Promise<PostPage | null> {
		const meta = await this.db.query.postMeta.findFirst();
		if (!meta || meta.deletedAt) return null;

		const tagRows = await this.db
			.select({kind: schema.tag.kind, label: schema.tag.label})
			.from(schema.tag);

		return {
			id: this.name,
			slug: meta.slug,
			title: meta.title,
			url: meta.url,
			host: meta.host,
			body: meta.body,
			author: meta.authorName,
			authorId: meta.authorId,
			score: meta.score,
			commentCount: meta.commentCount,
			createdAt: meta.createdAt ?? new Date(0),
			updatedAt: meta.updatedAt ?? meta.createdAt ?? new Date(0),
			tags: tagRows,
		};
	}

	/**
	 * All comments for this post, ordered by score then createdAt (matching
	 * the legacy singleton `Pano.listComments` contract).
	 *
	 * Reply-aware soft-delete (T12): a soft-deleted comment with non-deleted
	 * children stays in the tree with `body = '[silindi]'` and an empty
	 * authorId/authorName so the thread structure visible to readers is
	 * preserved; a soft-deleted comment without non-deleted children is
	 * omitted from the tree entirely so it disappears. The same logic runs
	 * inside the `CommentDeleted` projection step against `comment_view`,
	 * keeping per-DO and cross-product reads in lockstep.
	 */
	async listComments(): Promise<CommentRow[]> {
		const rows = await this.db
			.select()
			.from(schema.comment)
			.orderBy(desc(schema.comment.score), asc(schema.comment.createdAt));

		// Build set of parent ids that have at least one non-deleted child.
		// `parentsWithLiveChildren` is the source of truth for the placeholder
		// rewrite — a deleted comment with a live descendant must stay so the
		// tree doesn't lose intermediate structure.
		const parentsWithLiveChildren = new Set<string>();
		for (const c of rows) {
			if (c.deletedAt) continue;
			if (c.parentId) parentsWithLiveChildren.add(c.parentId);
		}

		const out: CommentRow[] = [];
		for (const c of rows) {
			if (c.deletedAt) {
				if (!parentsWithLiveChildren.has(c.id)) continue;
				out.push({
					id: c.id,
					parentId: c.parentId,
					author: "",
					authorId: "",
					body: SILINDI_PLACEHOLDER,
					score: c.score,
					createdAt: c.createdAt ?? new Date(0),
					updatedAt: c.updatedAt ?? c.createdAt ?? new Date(0),
				});
				continue;
			}
			out.push({
				id: c.id,
				parentId: c.parentId,
				author: c.authorName,
				authorId: c.authorId,
				body: c.body,
				score: c.score,
				createdAt: c.createdAt ?? new Date(0),
				updatedAt: c.updatedAt ?? c.createdAt ?? new Date(0),
			});
		}
		return out;
	}

	/* -------- Mutation surface ------------------------------------------ */

	/**
	 * Canonical write path for submitting a post (T7). The post id is the DO's
	 * own name (`this.name`) — the resolver mints it via `forge('post')` and
	 * routes through `idFromName(postId)`; this method assumes the DO is fresh
	 * (no `post_meta` row yet) and rejects if it already holds a post (the
	 * resolver creates a new ULID per call so re-entry is impossible in the
	 * happy path; we still guard).
	 *
	 * Atomicity per ADR 0007: in one `transactionSync` block we insert
	 * `post_meta`, the tag rows, and a single `PostChanged` outbox row carrying
	 * the denormalized aggregates. After commit we `setState` so WebSocket
	 * clients see the new state (T16) and `await flushOutbox` to ship the event
	 * to `PHOENIX_PROJECTION` for the `post_summary` MV.
	 *
	 * Validation (defense-in-depth — resolver enforces too):
	 * - `title` non-empty after trim, ≤ 200 chars
	 * - `url` (if provided) parses as a `URL`
	 * - `body` ≤ 10 000 chars
	 * - `tags` non-empty; every kind ∈ ALLOWED_POST_TAG_KINDS
	 *
	 * Throws `PostValidationError` for user-facing failures.
	 */
	async submitPost(input: SubmitPostInput): Promise<SubmitPostResult> {
		// ----- validation --------------------------------------------------
		const title = (input.title ?? "").trim();
		if (title.length === 0) {
			throw new PostValidationError("title_required", "başlık boş olamaz");
		}
		if (title.length > POST_TITLE_MAX) {
			throw new PostValidationError(
				"title_too_long",
				`başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
			);
		}

		const rawBody = input.body ?? "";
		if (rawBody.length > POST_BODY_MAX) {
			throw new PostValidationError(
				"body_too_long",
				`metin en fazla ${POST_BODY_MAX} karakter olabilir`,
			);
		}
		const body = rawBody.length === 0 ? null : rawBody;

		let host: string | null = null;
		let urlNormalized: string | null = null;
		if (input.url != null && input.url.length > 0) {
			let parsed: URL;
			try {
				parsed = new URL(input.url);
			} catch {
				throw new PostValidationError("url_invalid", "URL geçersiz");
			}
			urlNormalized = parsed.toString();
			host = parsed.host;
		}

		if (!input.tags || input.tags.length === 0) {
			throw new PostValidationError("tags_required", "en az bir etiket seç");
		}
		const allowed = new Set<string>(ALLOWED_POST_TAG_KINDS);
		const normalizedTags: PostTagRow[] = [];
		const seenKinds = new Set<string>();
		for (const t of input.tags) {
			const kind = (t.kind ?? "").trim();
			if (!allowed.has(kind)) {
				throw new PostValidationError("tag_invalid", `geçersiz etiket: ${kind || "(boş)"}`);
			}
			if (seenKinds.has(kind)) continue;
			seenKinds.add(kind);
			normalizedTags.push({kind, label: t.label?.trim() || kind});
		}

		// ----- guard against re-entry on an already-occupied DO ------------
		const existing = await this.db.query.postMeta.findFirst();
		if (existing) {
			// `submitPost` is supposed to be called exactly once per DO instance.
			// The resolver mints a fresh ULID per request; landing on an existing
			// post is a programmer error (e.g. someone called `submitPost` twice
			// on the same id). Surface as a clean error.
			throw new PostValidationError("title_required", "post zaten oluşturulmuş");
		}

		const now = Date.now();
		const eventId = id("evt");
		const postId = this.name;

		const hotScore = computeHotScore(0, now, now);
		const bodyExcerpt = body ? excerpt(body) : null;

		const payload = JSON.stringify({
			kind: "PostChanged",
			eventId,
			postId,
			slug: null,
			title,
			url: urlNormalized,
			host,
			bodyExcerpt,
			authorId: input.authorId,
			authorName: input.authorName,
			tags: normalizedTags.map((t) => t.kind),
			score: 0,
			commentCount: 0,
			hotScore,
			createdAt: now,
			updatedAt: now,
			lastActivityAt: now,
		});

		// ----- atomic write: post_meta + tags + outbox row ----------------
		// transactionSync requires the synchronous storage API (this.sql).
		// Pre-compute every value outside the closure so the only thing inside
		// is the wire-up.
		const createdAtSec = Math.floor(now / 1000);
		const tagInserts = normalizedTags.map((t) => ({
			id: id("tag"),
			kind: t.kind,
			label: t.label,
		}));

		this.ctx.storage.transactionSync(() => {
			this.sql`
				INSERT INTO post_meta (
					id, slug, title, url, host, body,
					author_id, author_name, score, comment_count,
					created_at, updated_at
				) VALUES (
					'1', NULL, ${title}, ${urlNormalized}, ${host}, ${body},
					${input.authorId}, ${input.authorName}, 0, 0,
					${createdAtSec}, ${createdAtSec}
				)
			`;
			for (const t of tagInserts) {
				this.sql`
					INSERT INTO tag (id, kind, label) VALUES (${t.id}, ${t.kind}, ${t.label})
				`;
			}
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${eventId}, ${payload}, ${now})
			`;
		});

		// ----- broadcast new aggregates via setState -----------------------
		this.setState({
			title,
			host,
			score: 0,
			commentCount: 0,
			hotScore,
			lastActivityAt: now,
			lastEventId: eventId,
		});

		// ----- ship the event ---------------------------------------------
		// Best-effort inline flush (cache hit path). Failures are absorbed
		// by the periodic `reconcileOutbox` schedule + on-start reconcile.
		try {
			await this.flushOutbox({eventId});
		} catch (err) {
			console.error("[PanoPost.submitPost] flushOutbox failed", err);
		}

		return {
			postId,
			title,
			url: urlNormalized,
			host,
			body,
			authorId: input.authorId,
			authorName: input.authorName,
			score: 0,
			commentCount: 0,
			tags: normalizedTags,
			createdAt: new Date(now),
		};
	}

	/**
	 * Cast an upvote on this post (T8). Idempotent: a second vote from the
	 * same voter is a no-op (composite PK + count-then-insert) — score stays
	 * at the current value, no events emitted.
	 *
	 * Atomicity per ADR 0007: a single `transactionSync` block writes the vote
	 * row, recomputes the post's denormalized `score` from the vote table,
	 * recomputes `hot_score` from the new score + age, and emits TWO outbox
	 * rows (PostChanged for `post_summary` convergence + VoteRecorded for the
	 * cross-product `user_vote` MV + karma side effect).
	 *
	 * Throws `PostNotFoundError` when no `post_meta` row exists in this DO
	 * (clients hit the wrong DO via wrong post id).
	 */
	async voteOnPost(input: VoteOnPostInput): Promise<VoteOnPostResult> {
		return this.applyVote(input, /* isVote */ true);
	}

	/**
	 * Retract a previously cast upvote (T8). Idempotent: retracting when no
	 * vote exists is a no-op — score unchanged, no events emitted.
	 */
	async retractPostVote(input: VoteOnPostInput): Promise<VoteOnPostResult> {
		return this.applyVote(input, /* isVote */ false);
	}

	/**
	 * Shared body for `voteOnPost` and `retractPostVote` — the only difference
	 * is the vote-table mutation (INSERT vs DELETE) and the sign of the
	 * `VoteRecorded` event's `value` field. Centralizing keeps the outbox +
	 * setState contract identical. Mirrors `SozlukTerm.applyVote` (T5).
	 */
	private async applyVote(input: VoteOnPostInput, isVote: boolean): Promise<VoteOnPostResult> {
		const meta = await this.db.query.postMeta.findFirst();
		if (!meta || meta.deletedAt) {
			throw new PostNotFoundError(this.name);
		}

		const tagRows = await this.db
			.select({kind: schema.tag.kind, label: schema.tag.label})
			.from(schema.tag);

		const now = Date.now();
		const postId = this.name;
		const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now;

		const postEventId = id("evt");
		const voteEventId = id("evt");

		// Closure-captured aggregates so post-commit setState can read final values.
		let changed = false;
		let newScore = meta.score;
		let newHotScore = computeHotScore(meta.score, createdAtMs, now);

		this.ctx.storage.transactionSync(() => {
			if (isVote) {
				// Count-then-insert with ON CONFLICT DO NOTHING fallback. Single-
				// instance DOs serialize, so the count-first branch is the
				// authoritative idempotency guard; the ON CONFLICT is belt-and-
				// suspenders for any future namespace collision.
				const before = this.sql<{n: number}>`
					SELECT COUNT(*) as n FROM post_vote
					WHERE post_id = ${postId} AND voter_id = ${input.voterId}
				`;
				const existed = (before[0]?.n ?? 0) > 0;
				if (!existed) {
					this.sql`
						INSERT INTO post_vote (post_id, voter_id, created_at)
						VALUES (${postId}, ${input.voterId}, ${Math.floor(now / 1000)})
						ON CONFLICT(post_id, voter_id) DO NOTHING
					`;
					changed = true;
				}
			} else {
				const before = this.sql<{n: number}>`
					SELECT COUNT(*) as n FROM post_vote
					WHERE post_id = ${postId} AND voter_id = ${input.voterId}
				`;
				const existed = (before[0]?.n ?? 0) > 0;
				if (existed) {
					this.sql`
						DELETE FROM post_vote
						WHERE post_id = ${postId} AND voter_id = ${input.voterId}
					`;
					changed = true;
				}
			}

			if (!changed) {
				newScore = meta.score;
				newHotScore = computeHotScore(meta.score, createdAtMs, now);
				return;
			}

			// Recompute denormalized score from the vote table (single source of
			// truth). Equivalent to SUM(*) on a presence-only table.
			const scoreRows = this.sql<{n: number}>`
				SELECT COUNT(*) as n FROM post_vote WHERE post_id = ${postId}
			`;
			newScore = scoreRows[0]?.n ?? 0;
			newHotScore = computeHotScore(newScore, createdAtMs, now);

			// Persist the recomputed score + updated_at on the singleton meta row.
			this.sql`
				UPDATE post_meta
				SET score = ${newScore}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = '1'
			`;

			// Outbox: PostChanged (post_summary convergence + hot_score refresh).
			const postPayload = JSON.stringify({
				kind: "PostChanged",
				eventId: postEventId,
				postId,
				slug: meta.slug,
				title: meta.title,
				url: meta.url,
				host: meta.host,
				bodyExcerpt: meta.body ? excerpt(meta.body) : null,
				authorId: meta.authorId,
				authorName: meta.authorName,
				tags: tagRows.map((t) => t.kind),
				score: newScore,
				commentCount: meta.commentCount,
				hotScore: newHotScore,
				createdAt: createdAtMs,
				updatedAt: now,
				lastActivityAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${postEventId}, ${postPayload}, ${now})
			`;

			// Outbox: VoteRecorded (user_vote MV + karma side effect).
			const votePayload = JSON.stringify({
				kind: "VoteRecorded",
				eventId: voteEventId,
				userId: input.voterId,
				targetKind: "post",
				targetId: postId,
				targetAuthorId: meta.authorId,
				value: isVote,
				createdAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${voteEventId}, ${votePayload}, ${now})
			`;
		});

		// Authoritative myVote from the post_vote table state. After a
		// successful cast, the row exists → 1; after a retract, it's gone → null.
		// Idempotent no-ops preserve whichever state was already there.
		const myVote = isVote ? 1 : null;

		const result: VoteOnPostResult = {
			postId,
			title: meta.title,
			url: meta.url,
			host: meta.host,
			body: meta.body,
			authorId: meta.authorId,
			authorName: meta.authorName,
			score: newScore,
			hotScore: newHotScore,
			commentCount: meta.commentCount,
			tags: tagRows,
			createdAt: meta.createdAt ?? new Date(now),
			myVote,
			changed,
		};

		if (!changed) return result;

		// Update Agent state (drives WebSocket broadcast in T16).
		this.setState({
			title: meta.title,
			host: meta.host,
			score: newScore,
			commentCount: meta.commentCount,
			hotScore: newHotScore,
			lastActivityAt: now,
			lastEventId: voteEventId,
		});

		// Best-effort inline flush. Failures absorbed by reconcileOutbox.
		try {
			await this.flushOutbox({eventId: postEventId});
		} catch (err) {
			console.error("[PanoPost.applyVote] flushOutbox(post) failed", err);
		}
		try {
			await this.flushOutbox({eventId: voteEventId});
		} catch (err) {
			console.error("[PanoPost.applyVote] flushOutbox(vote) failed", err);
		}

		return result;
	}

	/**
	 * Cast an upvote on a comment in this post (T11). Idempotent: a second
	 * vote from the same voter is a no-op — score stays put, no events emitted.
	 *
	 * Atomicity per ADR 0007: a single `transactionSync` block writes the
	 * comment_vote row, recomputes the comment's denormalized `score` from
	 * the vote table, and emits TWO outbox rows (CommentChanged for the
	 * `comment_view.score` convergence + VoteRecorded for the cross-product
	 * `user_vote` MV + karma side effect).
	 *
	 * Throws `CommentNotFoundError` when the comment doesn't exist or is
	 * soft-deleted in this DO.
	 */
	async voteOnComment(input: VoteOnCommentInput): Promise<VoteOnCommentResult> {
		return this.applyCommentVote(input, /* isVote */ true);
	}

	/**
	 * Retract a previously cast upvote on a comment (T11). Idempotent.
	 */
	async retractCommentVote(input: VoteOnCommentInput): Promise<VoteOnCommentResult> {
		return this.applyCommentVote(input, /* isVote */ false);
	}

	/**
	 * Shared body for `voteOnComment` / `retractCommentVote` — mirrors
	 * `applyVote` (post-level T8) and `SozlukTerm.applyVote` (T5).
	 */
	private async applyCommentVote(
		input: VoteOnCommentInput,
		isVote: boolean,
	): Promise<VoteOnCommentResult> {
		const row = await this.db.query.comment.findFirst({
			where: (c, {eq}) => eq(c.id, input.commentId),
		});
		if (!row || row.deletedAt) {
			throw new CommentNotFoundError(input.commentId);
		}

		const now = Date.now();
		const postId = this.name;
		const createdAtMs = row.createdAt ? row.createdAt.getTime() : now;
		const meta = await this.db.query.postMeta.findFirst();
		const targetAuthorId = row.authorId;

		const commentEventId = id("evt");
		const voteEventId = id("evt");

		let changed = false;
		let newScore = row.score;

		this.ctx.storage.transactionSync(() => {
			if (isVote) {
				const before = this.sql<{n: number}>`
					SELECT COUNT(*) as n FROM comment_vote
					WHERE comment_id = ${input.commentId} AND voter_id = ${input.voterId}
				`;
				const existed = (before[0]?.n ?? 0) > 0;
				if (!existed) {
					this.sql`
						INSERT INTO comment_vote (comment_id, voter_id, created_at)
						VALUES (${input.commentId}, ${input.voterId}, ${Math.floor(now / 1000)})
						ON CONFLICT(comment_id, voter_id) DO NOTHING
					`;
					changed = true;
				}
			} else {
				const before = this.sql<{n: number}>`
					SELECT COUNT(*) as n FROM comment_vote
					WHERE comment_id = ${input.commentId} AND voter_id = ${input.voterId}
				`;
				const existed = (before[0]?.n ?? 0) > 0;
				if (existed) {
					this.sql`
						DELETE FROM comment_vote
						WHERE comment_id = ${input.commentId} AND voter_id = ${input.voterId}
					`;
					changed = true;
				}
			}

			if (!changed) {
				newScore = row.score;
				return;
			}

			// Recompute denormalized score from the vote table (presence-only,
			// COUNT(*) is the canonical sum).
			const scoreRows = this.sql<{n: number}>`
				SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ${input.commentId}
			`;
			newScore = scoreRows[0]?.n ?? 0;

			// Persist the recomputed score + updated_at on the comment row.
			this.sql`
				UPDATE comment
				SET score = ${newScore}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = ${input.commentId}
			`;

			// Outbox: CommentChanged → comment_view.score convergence.
			const commentPayload = JSON.stringify({
				kind: "CommentChanged",
				eventId: commentEventId,
				commentId: input.commentId,
				score: newScore,
				updatedAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${commentEventId}, ${commentPayload}, ${now})
			`;

			// Outbox: VoteRecorded → user_vote MV + karma side effect on
			// the comment's author.
			const votePayload = JSON.stringify({
				kind: "VoteRecorded",
				eventId: voteEventId,
				userId: input.voterId,
				targetKind: "comment",
				targetId: input.commentId,
				targetAuthorId,
				value: isVote,
				createdAt: now,
			});
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${voteEventId}, ${votePayload}, ${now})
			`;
		});

		const myVote = isVote ? 1 : null;

		const result: VoteOnCommentResult = {
			commentId: input.commentId,
			postId,
			parentId: row.parentId,
			authorId: row.authorId,
			authorName: row.authorName,
			body: row.body,
			score: newScore,
			createdAt: row.createdAt ?? new Date(createdAtMs),
			myVote,
			changed,
		};

		if (!changed) return result;

		// Update Agent state for live-update subscribers (T16). We don't track
		// individual comment scores in PostState — the state bump just refreshes
		// `lastActivityAt` + `lastEventId` so the post page's WebSocket sees
		// activity. Keep meta-driven fields stable.
		this.setState({
			...this.state,
			title: meta?.title ?? this.state.title,
			host: meta?.host ?? this.state.host,
			score: meta?.score ?? this.state.score,
			commentCount: meta?.commentCount ?? this.state.commentCount,
			lastActivityAt: now,
			lastEventId: voteEventId,
		});

		// Best-effort inline flush; reconcileOutbox is the safety net.
		try {
			await this.flushOutbox({eventId: commentEventId});
		} catch (err) {
			console.error("[PanoPost.applyCommentVote] flushOutbox(comment) failed", err);
		}
		try {
			await this.flushOutbox({eventId: voteEventId});
		} catch (err) {
			console.error("[PanoPost.applyCommentVote] flushOutbox(vote) failed", err);
		}

		return result;
	}

	/**
	 * Add a comment to this post — top-level or nested (T10).
	 *
	 * Atomicity per ADR 0007: one `transactionSync` writes the `comment` row,
	 * bumps `post_meta.comment_count`, and emits TWO outbox events
	 * (`CommentAdded` for `comment_view` + `PostChanged` for `post_summary`'s
	 * commentCount convergence).
	 *
	 * Validation (defense-in-depth — resolver enforces too):
	 * - `body` non-empty after `trim`, ≤ 5 000 chars.
	 * - When `parentId` is provided it MUST reference an existing non-deleted
	 *   comment in this DO. The same-post invariant is trivially satisfied —
	 *   every comment in this DO belongs to this DO's post by construction.
	 *
	 * Throws:
	 * - `PostNotFoundError` when the DO is empty (idFromName hit a fresh DO).
	 * - `CommentValidationError` on validation failure.
	 */
	async addComment(input: AddCommentInput): Promise<AddCommentResult> {
		// ----- validation --------------------------------------------------
		const rawBody = input.body ?? "";
		if (rawBody.trim().length === 0) {
			throw new CommentValidationError("body_required", "yorum boş olamaz");
		}
		if (rawBody.length > COMMENT_BODY_MAX) {
			throw new CommentValidationError(
				"body_too_long",
				`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
			);
		}

		const meta = await this.db.query.postMeta.findFirst();
		if (!meta || meta.deletedAt) {
			throw new PostNotFoundError(this.name);
		}

		const parentId = input.parentId ?? null;
		if (parentId !== null) {
			// The per-post Agent owns the comment table, so a SELECT 1 against
			// the local DO is the canonical same-post + existence guard.
			const parentRows = this.sql<{id: string}>`
				SELECT id FROM comment WHERE id = ${parentId} AND deleted_at IS NULL
			`;
			if (parentRows.length === 0) {
				throw new CommentValidationError("parent_not_found", "yanıtlanan yorum bulunamadı");
			}
		}

		const tagRows = await this.db
			.select({kind: schema.tag.kind, label: schema.tag.label})
			.from(schema.tag);

		const now = Date.now();
		const postId = this.name;
		const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now;
		const commentId = id("comm");
		const commentEventId = id("evt");
		const postEventId = id("evt");
		const bodyExcerpt = excerpt(rawBody);
		const newCommentCount = meta.commentCount + 1;
		const hotScore = computeHotScore(meta.score, createdAtMs, now);

		const commentAddedPayload = JSON.stringify({
			kind: "CommentAdded",
			eventId: commentEventId,
			commentId,
			authorId: input.authorId,
			authorName: input.authorName,
			postId,
			postTitle: meta.title,
			postSlug: meta.slug,
			parentId,
			bodyExcerpt,
			score: 0,
			createdAt: now,
		});

		const postChangedPayload = JSON.stringify({
			kind: "PostChanged",
			eventId: postEventId,
			postId,
			slug: meta.slug,
			title: meta.title,
			url: meta.url,
			host: meta.host,
			bodyExcerpt: meta.body ? excerpt(meta.body) : null,
			authorId: meta.authorId,
			authorName: meta.authorName,
			tags: tagRows.map((t) => t.kind),
			score: meta.score,
			commentCount: newCommentCount,
			hotScore,
			createdAt: createdAtMs,
			updatedAt: now,
			lastActivityAt: now,
		});

		const createdAtSec = Math.floor(now / 1000);

		this.ctx.storage.transactionSync(() => {
			this.sql`
				INSERT INTO comment (
					id, parent_id, author_id, author_name, body, score,
					created_at, updated_at
				) VALUES (
					${commentId}, ${parentId}, ${input.authorId}, ${input.authorName},
					${rawBody}, 0, ${createdAtSec}, ${createdAtSec}
				)
			`;
			this.sql`
				UPDATE post_meta
				SET comment_count = ${newCommentCount}, updated_at = ${createdAtSec}
				WHERE id = '1'
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${commentEventId}, ${commentAddedPayload}, ${now})
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${postEventId}, ${postChangedPayload}, ${now})
			`;
		});

		this.setState({
			...this.state,
			commentCount: newCommentCount,
			hotScore,
			lastActivityAt: now,
			lastEventId: commentEventId,
		});

		// Best-effort inline flush (cache hit path). Failures absorbed by
		// the periodic + on-start `reconcileOutbox` schedule.
		try {
			await this.flushOutbox({eventId: commentEventId});
		} catch (err) {
			console.error("[PanoPost.addComment] flushOutbox(comment) failed", err);
		}
		try {
			await this.flushOutbox({eventId: postEventId});
		} catch (err) {
			console.error("[PanoPost.addComment] flushOutbox(post) failed", err);
		}

		return {
			commentId,
			postId,
			parentId,
			authorId: input.authorId,
			authorName: input.authorName,
			body: rawBody,
			score: 0,
			commentCount: newCommentCount,
			createdAt: new Date(now),
		};
	}

	/**
	 * Edit a comment's body (T12). Ownership is enforced inside the Agent —
	 * the resolver has already proven the caller is signed-in via
	 * `Auth.required`, but only the row's `author_id` decides who is allowed
	 * to mutate it. A mismatch throws `UnauthorizedCommentMutationError`,
	 * which the resolver translates to a GraphQL error with
	 * `code: 'UNAUTHORIZED'`.
	 *
	 * Atomicity per ADR 0007: one `transactionSync` block updates the `body`
	 * + `updated_at` columns and emits a `CommentEdited` outbox row so
	 * `comment_view.body_excerpt` converges via the existing projection step.
	 *
	 * Validation mirrors `addComment`:
	 * - body trim-non-empty
	 * - body ≤ 5 000 chars
	 *
	 * Throws:
	 * - `CommentNotFoundError` when the comment doesn't exist or is soft-deleted.
	 * - `UnauthorizedCommentMutationError` on author mismatch.
	 * - `CommentValidationError` on validation failure.
	 */
	async editComment(input: EditCommentInput): Promise<EditCommentResult> {
		const rawBody = input.body ?? "";
		if (rawBody.trim().length === 0) {
			throw new CommentValidationError("body_required", "yorum boş olamaz");
		}
		if (rawBody.length > COMMENT_BODY_MAX) {
			throw new CommentValidationError(
				"body_too_long",
				`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`,
			);
		}

		const row = await this.db.query.comment.findFirst({
			where: (c, {eq}) => eq(c.id, input.commentId),
		});
		if (!row || row.deletedAt) {
			throw new CommentNotFoundError(input.commentId);
		}
		if (row.authorId !== input.actorId) {
			throw new UnauthorizedCommentMutationError(input.commentId);
		}

		const now = Date.now();
		const eventId = id("evt");
		const bodyExcerpt = excerpt(rawBody);

		const payload = JSON.stringify({
			kind: "CommentEdited",
			eventId,
			commentId: input.commentId,
			bodyExcerpt,
			updatedAt: now,
		});

		this.ctx.storage.transactionSync(() => {
			this.sql`
				UPDATE comment
				SET body = ${rawBody}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = ${input.commentId}
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${eventId}, ${payload}, ${now})
			`;
		});

		this.setState({
			...this.state,
			lastActivityAt: now,
			lastEventId: eventId,
		});

		try {
			await this.flushOutbox({eventId});
		} catch (err) {
			console.error("[PanoPost.editComment] flushOutbox failed", err);
		}

		return {
			commentId: input.commentId,
			postId: this.name,
			parentId: row.parentId,
			authorId: row.authorId,
			authorName: row.authorName,
			body: rawBody,
			score: row.score,
			createdAt: row.createdAt ?? new Date(now),
			updatedAt: new Date(now),
		};
	}

	/**
	 * Soft-delete a comment (T12). Ownership-checked the same way as
	 * `editComment`. Sets `deleted_at = now` so `listComments` either omits
	 * the row (leaf) or rewrites it to `[silindi]` (has live replies);
	 * decrements `post_meta.commentCount` since reads filter deleted out.
	 *
	 * Reply-aware: the producer computes `hasReplies` (any non-deleted
	 * children) inside the same `transactionSync` and bakes it into the
	 * `CommentDeleted` event. The projection step uses `hasReplies` to decide
	 * whether to UPDATE `comment_view` to `body = '[silindi]'` (preserve thread
	 * shape) or DELETE the `comment_view` row entirely (remove from tree).
	 *
	 * Idempotent: re-deleting an already-deleted comment is a no-op
	 * (returns `deleted: false`, no events).
	 *
	 * Outbox: emits `CommentDeleted` (drives `comment_view` rewrite/removal)
	 * + `PostChanged` (decremented `commentCount` on `post_summary`).
	 *
	 * Throws:
	 * - `CommentNotFoundError` when the comment doesn't exist at all.
	 * - `UnauthorizedCommentMutationError` on author mismatch.
	 */
	async deleteComment(input: DeleteCommentInput): Promise<DeleteCommentResult> {
		// Read the row WITHOUT the deletedAt filter so we can detect "already
		// deleted" as an idempotent no-op (vs. "not found at all").
		const row = await this.db.query.comment.findFirst({
			where: (c, {eq}) => eq(c.id, input.commentId),
		});
		if (!row) {
			throw new CommentNotFoundError(input.commentId);
		}
		if (row.authorId !== input.actorId) {
			throw new UnauthorizedCommentMutationError(input.commentId);
		}
		if (row.deletedAt) {
			// Already soft-deleted → idempotent no-op.
			return {commentId: input.commentId, deleted: false, hasReplies: false};
		}

		const meta = await this.db.query.postMeta.findFirst();
		if (!meta) {
			throw new PostNotFoundError(this.name);
		}

		const tagRows = await this.db
			.select({kind: schema.tag.kind, label: schema.tag.label})
			.from(schema.tag);

		const now = Date.now();
		const postId = this.name;
		const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now;
		const commentEventId = id("evt");
		const postEventId = id("evt");

		// Compute hasReplies (any non-deleted child) — drives the projection's
		// reply-aware tree rewrite.
		const childRows = this.sql<{n: number}>`
			SELECT COUNT(*) as n FROM comment
			WHERE parent_id = ${input.commentId} AND deleted_at IS NULL
		`;
		const hasReplies = (childRows[0]?.n ?? 0) > 0;

		const newCommentCount = Math.max(0, meta.commentCount - 1);
		const hotScore = computeHotScore(meta.score, createdAtMs, now);

		const commentDeletedPayload = JSON.stringify({
			kind: "CommentDeleted",
			eventId: commentEventId,
			commentId: input.commentId,
			postId,
			parentId: row.parentId,
			authorId: row.authorId,
			hasReplies,
			deletedAt: now,
		});

		const postChangedPayload = JSON.stringify({
			kind: "PostChanged",
			eventId: postEventId,
			postId,
			slug: meta.slug,
			title: meta.title,
			url: meta.url,
			host: meta.host,
			bodyExcerpt: meta.body ? excerpt(meta.body) : null,
			authorId: meta.authorId,
			authorName: meta.authorName,
			tags: tagRows.map((t) => t.kind),
			score: meta.score,
			commentCount: newCommentCount,
			hotScore,
			createdAt: createdAtMs,
			updatedAt: now,
			lastActivityAt: now,
		});

		this.ctx.storage.transactionSync(() => {
			this.sql`
				UPDATE comment
				SET deleted_at = ${Math.floor(now / 1000)}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = ${input.commentId}
			`;
			this.sql`
				UPDATE post_meta
				SET comment_count = ${newCommentCount}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = '1'
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${commentEventId}, ${commentDeletedPayload}, ${now})
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${postEventId}, ${postChangedPayload}, ${now})
			`;
		});

		this.setState({
			...this.state,
			commentCount: newCommentCount,
			hotScore,
			lastActivityAt: now,
			lastEventId: postEventId,
		});

		try {
			await this.flushOutbox({eventId: commentEventId});
		} catch (err) {
			console.error("[PanoPost.deleteComment] flushOutbox(comment) failed", err);
		}
		try {
			await this.flushOutbox({eventId: postEventId});
		} catch (err) {
			console.error("[PanoPost.deleteComment] flushOutbox(post) failed", err);
		}

		return {commentId: input.commentId, deleted: true, hasReplies};
	}

	/**
	 * Edit a post's title and/or body (T9). Ownership is enforced inside the
	 * Agent — the resolver has already proven the caller is signed-in via
	 * `Auth.required`, but only the row's `author_id` decides who is allowed
	 * to mutate it. A mismatch throws `UnauthorizedPostMutationError`, which
	 * the resolver translates to a GraphQL error with `code: 'UNAUTHORIZED'`.
	 *
	 * Atomicity per ADR 0007: one `transactionSync` block updates the
	 * `title`/`body` + `updated_at` columns and emits a `PostChanged` outbox
	 * row (so `post_summary.title` + `body_excerpt` converge via the existing
	 * projection step). Score, commentCount, hotScore are unchanged on edit;
	 * we recompute hot_score against `now` to refresh the decay window so
	 * frequent edits don't accidentally re-rank the post.
	 *
	 * Validation:
	 * - At least one of `title` / `body` must be provided.
	 * - `title` (when given) non-empty after trim, ≤ 200 chars.
	 * - `body` (when given) ≤ 10 000 chars. Empty / blank body clears the
	 *   body to `null` (parity with submitPost's `null` semantics).
	 *
	 * Throws:
	 * - `PostNotFoundError` when the DO is empty (idFromName hit a fresh DO).
	 * - `UnauthorizedPostMutationError` on author mismatch.
	 * - `PostValidationError` on validation failure (re-used from submitPost).
	 */
	async editPost(input: EditPostInput): Promise<EditPostResult> {
		const meta = await this.db.query.postMeta.findFirst();
		if (!meta || meta.deletedAt) {
			throw new PostNotFoundError(this.name);
		}
		if (meta.authorId !== input.actorId) {
			throw new UnauthorizedPostMutationError(this.name);
		}

		// At least one of title/body required.
		const hasTitle = input.title !== undefined;
		const hasBody = input.body !== undefined;
		if (!hasTitle && !hasBody) {
			throw new PostValidationError("title_required", "başlık veya metin gerekli");
		}

		// Normalize title (if provided).
		let nextTitle = meta.title;
		if (hasTitle) {
			const trimmed = (input.title ?? "").trim();
			if (trimmed.length === 0) {
				throw new PostValidationError("title_required", "başlık boş olamaz");
			}
			if (trimmed.length > POST_TITLE_MAX) {
				throw new PostValidationError(
					"title_too_long",
					`başlık en fazla ${POST_TITLE_MAX} karakter olabilir`,
				);
			}
			nextTitle = trimmed;
		}

		// Normalize body (if provided). Empty / blank body clears to null.
		let nextBody: string | null = meta.body;
		if (hasBody) {
			const raw = input.body ?? "";
			if (raw.length > POST_BODY_MAX) {
				throw new PostValidationError(
					"body_too_long",
					`metin en fazla ${POST_BODY_MAX} karakter olabilir`,
				);
			}
			nextBody = raw.length === 0 ? null : raw;
		}

		const tagRows = await this.db
			.select({kind: schema.tag.kind, label: schema.tag.label})
			.from(schema.tag);

		const now = Date.now();
		const postId = this.name;
		const createdAtMs = meta.createdAt ? meta.createdAt.getTime() : now;
		const eventId = id("evt");
		const bodyExcerpt = nextBody ? excerpt(nextBody) : null;
		const hotScore = computeHotScore(meta.score, createdAtMs, now);

		const payload = JSON.stringify({
			kind: "PostChanged",
			eventId,
			postId,
			slug: meta.slug,
			title: nextTitle,
			url: meta.url,
			host: meta.host,
			bodyExcerpt,
			authorId: meta.authorId,
			authorName: meta.authorName,
			tags: tagRows.map((t) => t.kind),
			score: meta.score,
			commentCount: meta.commentCount,
			hotScore,
			createdAt: createdAtMs,
			updatedAt: now,
			lastActivityAt: now,
		});

		this.ctx.storage.transactionSync(() => {
			this.sql`
				UPDATE post_meta
				SET title = ${nextTitle}, body = ${nextBody}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = '1'
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${eventId}, ${payload}, ${now})
			`;
		});

		this.setState({
			...this.state,
			title: nextTitle,
			hotScore,
			lastActivityAt: now,
			lastEventId: eventId,
		});

		try {
			await this.flushOutbox({eventId});
		} catch (err) {
			console.error("[PanoPost.editPost] flushOutbox failed", err);
		}

		return {
			postId,
			title: nextTitle,
			url: meta.url,
			host: meta.host,
			body: nextBody,
			authorId: meta.authorId,
			authorName: meta.authorName,
			score: meta.score,
			hotScore,
			commentCount: meta.commentCount,
			tags: tagRows,
			createdAt: meta.createdAt ?? new Date(createdAtMs),
			updatedAt: new Date(now),
		};
	}

	/**
	 * Delete a post (T9). Ownership-checked the same way as `editPost`.
	 * Stamps `deleted_at` on `post_meta` (so `getPost` returns null), then emits
	 * a `PostDeleted` outbox event. The projection step (`PostDeleted`) REMOVES
	 * the row from `post_summary` entirely (vs. soft-stamping like definitions)
	 * per the PRD spec — deleted posts disappear from the feed.
	 *
	 * Idempotent: re-deleting an already-deleted post is a no-op (returns
	 * `deleted: false`, no events).
	 */
	async deletePost(input: DeletePostInput): Promise<DeletePostResult> {
		const meta = await this.db.query.postMeta.findFirst();
		if (!meta) {
			throw new PostNotFoundError(this.name);
		}
		if (meta.authorId !== input.actorId) {
			throw new UnauthorizedPostMutationError(this.name);
		}
		if (meta.deletedAt) {
			// Already deleted → idempotent no-op.
			return {postId: this.name, deleted: false};
		}

		const now = Date.now();
		const postId = this.name;
		const eventId = id("evt");

		const payload = JSON.stringify({
			kind: "PostDeleted",
			eventId,
			postId,
			authorId: meta.authorId,
			deletedAt: now,
		});

		this.ctx.storage.transactionSync(() => {
			this.sql`
				UPDATE post_meta
				SET deleted_at = ${Math.floor(now / 1000)}, updated_at = ${Math.floor(now / 1000)}
				WHERE id = '1'
			`;
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${eventId}, ${payload}, ${now})
			`;
		});

		this.setState({
			...this.state,
			lastActivityAt: now,
			lastEventId: eventId,
		});

		try {
			await this.flushOutbox({eventId});
		} catch (err) {
			console.error("[PanoPost.deletePost] flushOutbox failed", err);
		}

		return {postId, deleted: true};
	}

	/* -------- Seed surface ---------------------------------------------- */

	/**
	 * Admin-only post + tags + comments upsert. Used by the dev seeder
	 * (`pnpm pano:import`) which mirrors the legacy `Pano.seedIfEmpty` data.
	 * The canonical mutation surface (`submitPost`, `addComment`) lands in
	 * T7/T10 and uses the producer pattern (atomic outbox + flushOutbox).
	 *
	 * For seed we write directly via drizzle and emit a single `PostChanged`
	 * event to populate `post_summary` — same observable read state.
	 *
	 * Idempotent: re-running on an existing post short-circuits.
	 */
	async seed(input: SeedPostInput): Promise<SeedPostResult> {
		const now = Date.now();
		const existing = await this.db.query.postMeta.findFirst();
		if (existing) {
			return {created: false, insertedComments: 0, insertedTags: 0};
		}

		const host = input.url ? safeHost(input.url) : null;
		await this.db.insert(schema.postMeta).values({
			id: "1",
			title: input.title,
			url: input.url ?? null,
			host,
			body: input.body ?? null,
			authorId: input.authorId,
			authorName: input.authorName,
			score: input.score,
			commentCount: input.comments.length,
		});

		let insertedTags = 0;
		for (const t of input.tags) {
			await this.db.insert(schema.tag).values({kind: t.kind, label: t.label});
			insertedTags++;
		}

		// Two-pass: top-level first (so children can reference parents).
		const insertedIds: string[] = [];
		for (const c of input.comments) {
			const parentId = c.parentIdx != null ? (insertedIds[c.parentIdx] ?? null) : null;
			const [insertedComment] = await this.db
				.insert(schema.comment)
				.values({
					parentId,
					authorId: c.authorId,
					authorName: c.authorName,
					body: c.body,
					score: c.score ?? 0,
				})
				.returning({id: schema.comment.id});
			insertedIds.push(insertedComment?.id ?? "");
		}

		// Recompute aggregates from sqlite truth.
		const aggregates = await this.recomputeAggregates();
		const createdAtMs = now;
		const hotScore = computeHotScore(aggregates.score, createdAtMs, now);

		const eventId = id("evt");
		const nextState: PostState = {
			title: input.title,
			host,
			score: aggregates.score,
			commentCount: aggregates.commentCount,
			hotScore,
			lastActivityAt: now,
			lastEventId: eventId,
		};

		const payload = JSON.stringify({
			kind: "PostChanged",
			eventId,
			postId: this.name,
			slug: null,
			title: input.title,
			url: input.url ?? null,
			host,
			bodyExcerpt: input.body ? excerpt(input.body) : null,
			authorId: input.authorId,
			authorName: input.authorName,
			tags: input.tags.map((t) => t.kind),
			score: aggregates.score,
			commentCount: aggregates.commentCount,
			hotScore,
			createdAt: createdAtMs,
			updatedAt: createdAtMs,
			lastActivityAt: now,
		});

		this.ctx.storage.transactionSync(() => {
			this.sql`
				INSERT INTO outbox (event_id, payload, created_at)
				VALUES (${eventId}, ${payload}, ${now})
			`;
		});

		this.setState(nextState);

		try {
			await this.flushOutbox({eventId});
		} catch (err) {
			console.error("[PanoPost.seed] flushOutbox failed", err);
		}

		return {
			created: true,
			insertedComments: insertedIds.filter(Boolean).length,
			insertedTags,
		};
	}

	/**
	 * Wipe every comment + tag + the post_meta row. Used by the dev seeder's
	 * `--clear` flag. The DO instance itself can't be deleted from inside;
	 * cleanup runs at the namespace level when needed.
	 */
	async clearAll(): Promise<{post: boolean; comments: number; tags: number}> {
		const comments = await this.db.select({id: schema.comment.id}).from(schema.comment);
		const tags = await this.db.select({id: schema.tag.id}).from(schema.tag);
		const meta = await this.db.query.postMeta.findFirst();

		await this.db.delete(schema.commentVote);
		await this.db.delete(schema.postVote);
		await this.db.delete(schema.comment);
		await this.db.delete(schema.tag);
		await this.db.delete(schema.postMeta);
		await this.db.delete(schema.outbox);

		this.setState(INITIAL_STATE);

		return {
			post: !!meta,
			comments: comments.length,
			tags: tags.length,
		};
	}

	/* -------- Outbox dispatcher ----------------------------------------- */

	/**
	 * Auto-dispatched callback for `this.queue('flushOutbox', {eventId})`
	 * (in T7+). Reads the outbox row, posts it to `PHOENIX_PROJECTION`,
	 * deletes the row on success. Idempotent: missing row = already flushed.
	 *
	 * Throws on workflow.create failure → Agent SDK retries per RetryOptions.
	 */
	async flushOutbox({eventId}: {eventId: string}): Promise<void> {
		const rows = this.sql<{payload: string}>`
			SELECT payload FROM outbox WHERE event_id = ${eventId}
		`;
		if (rows.length === 0) return;

		const payload = JSON.parse(rows[0]!.payload);
		await this.env.PHOENIX_PROJECTION.create({
			id: eventId,
			params: payload,
		});

		this.sql`DELETE FROM outbox WHERE event_id = ${eventId}`;
	}

	/* -------- Internals -------------------------------------------------- */

	/**
	 * Recompute denormalized aggregates from sqlite. Used by both seed and
	 * (in T7+) by mutation methods to assemble the `PostChanged` payload.
	 * Filtered to non-deleted comments per the read path's contract.
	 */
	private async recomputeAggregates(): Promise<{
		score: number;
		commentCount: number;
	}> {
		const meta = await this.db.query.postMeta.findFirst();
		const comments = await this.db
			.select({id: schema.comment.id})
			.from(schema.comment)
			.where(isNull(schema.comment.deletedAt));

		return {
			score: meta?.score ?? 0,
			commentCount: comments.length,
		};
	}
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function safeHost(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

const EXCERPT_LEN = 280;

function excerpt(body: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= EXCERPT_LEN) return flat;
	return `${flat.slice(0, EXCERPT_LEN - 1).trimEnd()}…`;
}
