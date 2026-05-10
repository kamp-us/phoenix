import {DurableObject} from "cloudflare:workers";
import {asc, count, desc, eq, sql} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import migrations from "./drizzle/migrations/migrations";
import * as schema from "./drizzle/schema";
import {SEED_POSTS} from "./seed";

export type PostSort = "hot" | "new" | "top";

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
