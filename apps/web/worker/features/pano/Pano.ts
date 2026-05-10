import {DurableObject} from "cloudflare:workers";
import {and, asc, count, desc, eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./drizzle/migrations/migrations";
import * as schema from "./drizzle/schema";
import {SEED_POSTS} from "./seed";

export type PostSort = "hot" | "new" | "top";

/** -1 retracts the (synthetic) score, 1 boosts it, 0 clears any existing vote. */
export type VoteValue = -1 | 0 | 1;

export interface VoteResult {
	score: number;
}

export interface PostTag {
	kind: string;
	label: string;
}

export interface PostSummary {
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
	tags: PostTag[];
}

export interface PostPage extends PostSummary {}

export interface CommentRow {
	id: string;
	parentId: string | null;
	author: string;
	body: string;
	score: number;
	createdAt: Date;
}

export class Pano extends DurableObject<Env> {
	db = drizzle(this.ctx.storage, {schema});

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			await this.seedIfEmpty();
		});
	}

	async listPosts(
		opts: {sort?: PostSort; limit?: number; host?: string} = {},
	): Promise<PostSummary[]> {
		const sort = opts.sort ?? "hot";
		const limit = opts.limit ?? 50;
		const host = opts.host;

		/* Aggregate tags into a JSON array on the post row so list rendering
		   stays one round-trip. SQLite's `json_group_array` + `json_object`
		   builds the structure inline; we parse on the way out. */
		const rows = await this.db
			.select({
				id: schema.post.id,
				slug: schema.post.slug,
				title: schema.post.title,
				url: schema.post.url,
				host: schema.post.host,
				body: schema.post.body,
				authorName: schema.post.authorName,
				score: schema.post.score,
				commentCount: schema.post.commentCount,
				createdAt: schema.post.createdAt,
				tagsJson: sql<string>`coalesce(
					json_group_array(
						case when ${schema.tag.id} is null then null
						else json_object('kind', ${schema.tag.kind}, 'label', ${schema.tag.label})
						end
					),
					'[]'
				)`,
			})
			.from(schema.post)
			.leftJoin(schema.tag, eq(schema.tag.postId, schema.post.id))
			.where(host ? eq(schema.post.host, host) : undefined)
			.groupBy(schema.post.id)
			.orderBy(sort === "new" ? desc(schema.post.createdAt) : desc(schema.post.score))
			.limit(limit);

		return rows.map((r) => ({
			id: r.id,
			slug: r.slug,
			title: r.title,
			url: r.url,
			host: r.host,
			body: r.body,
			author: r.authorName,
			score: r.score,
			commentCount: r.commentCount,
			createdAt: r.createdAt ?? new Date(0),
			tags: parseTags(r.tagsJson),
		}));
	}

	async getPost(idOrSlug: string): Promise<PostPage | null> {
		const p = await this.db.query.post.findFirst({
			where: (post, {eq, or}) => or(eq(post.id, idOrSlug), eq(post.slug, idOrSlug)),
		});
		if (!p) return null;

		const tagRows = await this.db
			.select({kind: schema.tag.kind, label: schema.tag.label})
			.from(schema.tag)
			.where(eq(schema.tag.postId, p.id));

		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			url: p.url,
			host: p.host,
			body: p.body,
			author: p.authorName,
			score: p.score,
			commentCount: p.commentCount,
			createdAt: p.createdAt ?? new Date(0),
			tags: tagRows,
		};
	}

	async listComments(postId: string): Promise<CommentRow[]> {
		const rows = await this.db
			.select()
			.from(schema.comment)
			.where(eq(schema.comment.postId, postId))
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

	/**
	 * Cast a vote on a post for `userId`. `value: 0` retracts; ±1 upserts.
	 *
	 * The vote write and the `post.score` recompute happen in a single
	 * transaction so the denormalized score never disagrees with the
	 * underlying votes. Score is `seedScore + sum(vote.value)` — the seed
	 * acts as the synthetic baseline so existing posts don't reset to zero
	 * the first time someone votes on them.
	 *
	 * Implementation note: we don't carry a separate `seedScore` column.
	 * Instead, on the first vote against a post, we snapshot the current
	 * score into the seed by computing `currentScore - oldVoteSum + newVoteSum`.
	 * Since `oldVoteSum` and `newVoteSum` are both fully reflected in the
	 * `post_vote` table after the write, the recompute reduces to:
	 *   newScore = (current - oldVote) + newVote
	 * — which is exactly `oldScore - oldValue + newValue`. We capture
	 * `oldValue` before mutating, then write `oldScore + (newValue - oldValue)`.
	 */
	async voteOnPost(input: {
		userId: string;
		postId: string;
		value: VoteValue;
	}): Promise<VoteResult> {
		const {userId, postId, value} = input;

		return this.db.transaction((tx) => {
			const existing = tx
				.select({value: schema.postVote.value})
				.from(schema.postVote)
				.where(
					and(eq(schema.postVote.userId, userId), eq(schema.postVote.postId, postId)),
				)
				.all();
			const oldValue = existing[0]?.value ?? 0;

			if (value === 0) {
				if (oldValue !== 0) {
					tx.delete(schema.postVote)
						.where(
							and(
								eq(schema.postVote.userId, userId),
								eq(schema.postVote.postId, postId),
							),
						)
						.run();
				}
			} else {
				tx.insert(schema.postVote)
					.values({userId, postId, value})
					.onConflictDoUpdate({
						target: [schema.postVote.userId, schema.postVote.postId],
						set: {value},
					})
					.run();
			}

			const delta = value - oldValue;
			const updated = tx
				.update(schema.post)
				.set({score: sql`${schema.post.score} + ${delta}`})
				.where(eq(schema.post.id, postId))
				.returning({score: schema.post.score})
				.all();
			const score = updated[0]?.score ?? 0;
			return {score};
		});
	}

	/** Mirrors `voteOnPost` for comments — see that method for the score-recompute reasoning. */
	async voteOnComment(input: {
		userId: string;
		commentId: string;
		value: VoteValue;
	}): Promise<VoteResult> {
		const {userId, commentId, value} = input;

		return this.db.transaction((tx) => {
			const existing = tx
				.select({value: schema.commentVote.value})
				.from(schema.commentVote)
				.where(
					and(
						eq(schema.commentVote.userId, userId),
						eq(schema.commentVote.commentId, commentId),
					),
				)
				.all();
			const oldValue = existing[0]?.value ?? 0;

			if (value === 0) {
				if (oldValue !== 0) {
					tx.delete(schema.commentVote)
						.where(
							and(
								eq(schema.commentVote.userId, userId),
								eq(schema.commentVote.commentId, commentId),
							),
						)
						.run();
				}
			} else {
				tx.insert(schema.commentVote)
					.values({userId, commentId, value})
					.onConflictDoUpdate({
						target: [schema.commentVote.userId, schema.commentVote.commentId],
						set: {value},
					})
					.run();
			}

			const delta = value - oldValue;
			const updated = tx
				.update(schema.comment)
				.set({score: sql`${schema.comment.score} + ${delta}`})
				.where(eq(schema.comment.id, commentId))
				.returning({score: schema.comment.score})
				.all();
			const score = updated[0]?.score ?? 0;
			return {score};
		});
	}

	private async seedIfEmpty(): Promise<void> {
		const rows = await this.db.select({n: count(schema.post.id)}).from(schema.post);
		if (Number(rows[0]?.n ?? 0) > 0) return;

		for (const seed of SEED_POSTS) {
			const host = seed.url ? safeHost(seed.url) : null;

			const [insertedPost] = await this.db
				.insert(schema.post)
				.values({
					title: seed.title,
					url: seed.url ?? null,
					host,
					body: seed.body ?? null,
					authorId: seed.authorId,
					authorName: seed.authorName,
					score: seed.score,
					commentCount: seed.comments.length,
				})
				.returning({id: schema.post.id});
			if (!insertedPost) continue;

			for (const t of seed.tags) {
				await this.db.insert(schema.tag).values({
					kind: t.kind,
					label: t.label,
					postId: insertedPost.id,
				});
			}

			/* Two-pass insert: top-level comments first so each child can
			   reference an already-inserted parent's generated id. */
			const insertedIds: string[] = [];
			for (const c of seed.comments) {
				const parentId =
					c.parentIdx != null ? (insertedIds[c.parentIdx] ?? null) : null;
				const [insertedComment] = await this.db
					.insert(schema.comment)
					.values({
						postId: insertedPost.id,
						parentId,
						authorId: c.authorId,
						authorName: c.authorName,
						body: c.body,
						score: c.score,
					})
					.returning({id: schema.comment.id});
				insertedIds.push(insertedComment?.id ?? "");
			}
		}
	}
}

function safeHost(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

function parseTags(json: string): PostTag[] {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!Array.isArray(parsed)) return [];
		const out: PostTag[] = [];
		for (const item of parsed) {
			if (
				item &&
				typeof item === "object" &&
				typeof (item as PostTag).kind === "string" &&
				typeof (item as PostTag).label === "string"
			) {
				out.push({kind: (item as PostTag).kind, label: (item as PostTag).label});
			}
		}
		return out;
	} catch {
		return [];
	}
}
