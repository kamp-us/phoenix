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
	 * Periodic outbox reconciliation (5 min) per ADR 0007. The reconcile body
	 * itself is implemented in T7 along with `flushOutbox`; this `onStart`
	 * only sets the schedule so T7 doesn't need to retroactively touch
	 * lifecycle.
	 */
	override async onStart() {
		if (!(await this.getScheduleById("reconcile-outbox"))) {
			await this.scheduleEvery(300, "reconcileOutbox");
		}
	}

	/**
	 * Stub for the periodic schedule. Real body lands in T7. Throwing here
	 * would loop the schedule; we no-op so the schedule is safely live.
	 */
	async reconcileOutbox(): Promise<void> {
		// Implemented in T7+ (mutation surface).
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
