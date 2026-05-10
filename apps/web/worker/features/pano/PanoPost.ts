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
	score: number;
	commentCount: number;
	createdAt: Date;
	tags: PostTagRow[];
}

export interface CommentRow {
	id: string;
	parentId: string | null;
	author: string;
	body: string;
	score: number;
	createdAt: Date;
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
export const ALLOWED_POST_TAG_KINDS = [
	"göster",
	"tartışma",
	"soru",
	"söylenme",
	"meta",
] as const;

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
			score: meta.score,
			commentCount: meta.commentCount,
			createdAt: meta.createdAt ?? new Date(0),
			tags: tagRows,
		};
	}

	/**
	 * All comments for this post, ordered by score then createdAt (matching
	 * the legacy singleton `Pano.listComments` contract). Soft-deleted rows
	 * are filtered out; the per-comment placeholder semantics for
	 * deleted-with-children land in T12.
	 */
	async listComments(): Promise<CommentRow[]> {
		const rows = await this.db
			.select()
			.from(schema.comment)
			.where(isNull(schema.comment.deletedAt))
			.orderBy(desc(schema.comment.score), asc(schema.comment.createdAt));

		return rows.map((c) => ({
			id: c.id,
			parentId: c.parentId,
			author: c.authorName,
			body: c.body,
			score: c.score,
			createdAt: c.createdAt ?? new Date(0),
		}));
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
