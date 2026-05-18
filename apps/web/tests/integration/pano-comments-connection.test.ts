/**
 * `Pano.listCommentsConnection` — Effect service surface (effect-migration
 * task 5). Reply-aware tree shape preserved; cursor encoding and totalCount
 * semantics unchanged.
 */
import {env} from "cloudflare:workers";
import {id} from "@usirin/forge";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	type AddCommentInput,
	type DeleteCommentInput,
	Pano,
	PanoLive,
	type SubmitPostInput,
} from "../../worker/features/pano/Pano";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = PanoLive.pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

function submitPost(input: SubmitPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function addComment(input: AddCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.addComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function deleteComment(input: DeleteCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.deleteComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function listCommentsConnection(
	postId: string,
	opts: {first?: number; after?: string | null} = {},
) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.listCommentsConnection(postId, opts);
		}).pipe(Effect.provide(TestLive)),
	);
}

async function applyViewMigrations() {
	const sources = [baselineMigration];
	for (const src of sources) {
		const statements = src
			.split("--> statement-breakpoint")
			.map((s: string) => s.trim())
			.filter(Boolean);
		for (const stmt of statements) {
			try {
				await env.PHOENIX_DB.prepare(stmt).run();
			} catch (err) {
				const msg = String(err);
				if (
					!msg.includes("already exists") &&
					!msg.includes("duplicate column") &&
					!msg.includes("no such table") &&
					!msg.includes("no such index")
				) {
					throw err;
				}
			}
		}
	}
}

async function seedPostWithComments(opts: {
	authorId: string;
	authorName?: string;
	commentCount: number;
}) {
	const post = await submitPost({
		title: "comment connection test başlık",
		body: "comment connection test body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "post author",
	});
	const commentIds: string[] = [];
	for (let i = 0; i < opts.commentCount; i++) {
		const r = await addComment({
			postId: post.postId,
			authorId: `c-author-${i}`,
			authorName: `commenter ${i}`,
			body: `comment ${i} body — long enough to satisfy minimum length`,
		});
		commentIds.push(r.commentId);
	}
	return {postId: post.postId, commentIds};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("Pano.listCommentsConnection", () => {
	it("paginates chronologically through every comment with a stable cursor", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-1",
			commentCount: 5,
		});

		const page1 = await listCommentsConnection(postId, {first: 2});
		expect(page1.rows).toHaveLength(2);
		expect(page1.hasNextPage).toBe(true);
		expect(page1.totalCount).toBe(5);
		expect(page1.rows.map((r) => r.id)).toEqual(commentIds.slice(0, 2));
		expect(page1.endCursor).toBe(commentIds[1]);

		const page2 = await listCommentsConnection(postId, {
			first: 2,
			after: page1.endCursor,
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.hasNextPage).toBe(true);
		expect(page2.totalCount).toBe(5);
		expect(page2.rows.map((r) => r.id)).toEqual(commentIds.slice(2, 4));
		expect(page2.endCursor).toBe(commentIds[3]);

		const page3 = await listCommentsConnection(postId, {
			first: 2,
			after: page2.endCursor,
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.hasNextPage).toBe(false);
		expect(page3.totalCount).toBe(5);
		expect(page3.rows.map((r) => r.id)).toEqual([commentIds[4]]);
	});

	it("reflects the reply-aware list length in totalCount (parent-with-replies stays, leaf-deleted is gone)", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-2",
			commentCount: 3,
		});
		const reply = await addComment({
			postId,
			authorId: "c-reply",
			authorName: "reply author",
			body: "child of comment 0 — keeps comment 0 alive as [silindi] placeholder",
			parentId: commentIds[0]!,
		});

		await deleteComment({commentId: commentIds[0]!, actorId: "c-author-0"});
		await deleteComment({commentId: commentIds[2]!, actorId: "c-author-2"});

		const page = await listCommentsConnection(postId, {first: 50});
		const ids = page.rows.map((r) => r.id);
		expect(ids).toContain(commentIds[0]);
		expect(ids).toContain(commentIds[1]);
		expect(ids).toContain(reply.commentId);
		expect(ids).not.toContain(commentIds[2]);
		expect(page.totalCount).toBe(3);

		const placeholder = page.rows.find((r) => r.id === commentIds[0]);
		expect(placeholder).toBeDefined();
		expect(placeholder!.body).toBe("[silindi]");
		expect(placeholder!.authorId).toBe("");
		expect(placeholder!.deletedAt).not.toBeNull();
		expect(placeholder!.deletedAt instanceof Date).toBe(true);

		const live = page.rows.find((r) => r.id === commentIds[1]);
		expect(live!.deletedAt).toBeNull();
	});

	it("returns an empty page on a stale cursor (never-existed comment id)", async () => {
		const {postId} = await seedPostWithComments({
			authorId: "p-author-3",
			commentCount: 3,
		});
		const stale = id("comm");
		const page = await listCommentsConnection(postId, {first: 2, after: stale});
		expect(page.rows).toEqual([]);
		expect(page.hasNextPage).toBe(false);
		expect(page.endCursor).toBeNull();
		expect(page.totalCount).toBe(3);
	});

	it("returns an empty page when the `after` row was removed between pages", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-6",
			commentCount: 4,
		});
		const page1 = await listCommentsConnection(postId, {first: 2});
		expect(page1.endCursor).toBe(commentIds[1]);
		expect(page1.hasNextPage).toBe(true);

		await deleteComment({commentId: commentIds[1]!, actorId: "c-author-1"});

		const page2 = await listCommentsConnection(postId, {
			first: 2,
			after: page1.endCursor,
		});
		expect(page2.rows).toEqual([]);
		expect(page2.hasNextPage).toBe(false);
		expect(page2.endCursor).toBeNull();
		expect(page2.totalCount).toBe(3);
	});
});

describe("Pano.deleteComment placeholder shape", () => {
	it("returns a placeholder Comment row when the deleted comment has live replies", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-4",
			commentCount: 1,
		});
		await addComment({
			postId,
			authorId: "c-child",
			authorName: "child",
			body: "child of comment 0 keeping the parent alive",
			parentId: commentIds[0]!,
		});

		const result = await deleteComment({
			commentId: commentIds[0]!,
			actorId: "c-author-0",
		});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);
		expect(result.placeholder).not.toBeNull();
		expect(result.placeholder!.id).toBe(commentIds[0]);
		expect(result.placeholder!.body).toBe("[silindi]");
		expect(result.placeholder!.authorId).toBe("");
		expect(result.placeholder!.deletedAt).not.toBeNull();
	});

	it("returns null placeholder for a leaf delete (no live children)", async () => {
		const {commentIds} = await seedPostWithComments({
			authorId: "p-author-5",
			commentCount: 1,
		});

		const result = await deleteComment({
			commentId: commentIds[0]!,
			actorId: "c-author-0",
		});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);
		expect(result.placeholder).toBeNull();
	});
});
