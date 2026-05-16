/**
 * `editComment` / `deleteComment` on D1-direct — d1-direct/task_8.
 *
 * Exercises the D1-direct comment lifecycle end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a post + comment (D1-direct task_7 + task_8 paths).
 *   3. Edit the body → `comment_view.body` + `body_excerpt` refresh inline.
 *   4. Ownership: a non-author actor's edit / delete throws
 *      `UnauthorizedCommentMutationError`.
 *   5. Delete a *leaf* comment → row fully removed from `comment_view`;
 *      `post_summary.comment_count` decremented.
 *   6. Delete a *parent* with replies → soft-stamps `deleted_at`,
 *      rewrites `body_excerpt = '[silindi]'`, drops votes; per-post
 *      reader returns the placeholder so the SPA preserves the tree shape.
 *   7. Idempotent re-delete on an already-deleted comment is a no-op.
 *   8. `CommentNotFoundError` for an unknown comment id.
 *
 * Zero `runInDurableObject` blocks — the module writes D1 directly.
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";
import viewMigration0005 from "../../worker/db/drizzle/migrations/0005_d1_direct_sozluk.sql";
import viewMigration0006 from "../../worker/db/drizzle/migrations/0006_d1_direct_pano.sql";
import viewMigration0007 from "../../worker/db/drizzle/migrations/0007_d1_direct_pano_comments.sql";
import {
	addComment,
	deleteComment,
	editComment,
	listComments,
	submitPost,
} from "../../worker/features/pano/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [
		viewMigration0000,
		viewMigration0001,
		viewMigration0002,
		viewMigration0003,
		viewMigration0005,
		viewMigration0006,
		viewMigration0007,
	];
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

async function seedPostAndComment(opts: {
	postAuthorId: string;
	commentAuthorId: string;
	commentBody?: string;
	postTitle?: string;
}) {
	const post = await submitPost(env, {
		title: opts.postTitle ?? `edit/delete seed ${opts.postAuthorId}`,
		tags: [{kind: "tartışma"}],
		authorId: opts.postAuthorId,
		authorName: "post author",
	});
	const comment = await addComment(env, {
		postId: post.postId,
		authorId: opts.commentAuthorId,
		authorName: "comment author",
		body: opts.commentBody ?? "original comment body",
	});
	return {postId: post.postId, commentId: comment.commentId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano/module editComment — d1-direct/task_8", () => {
	it("updates body + body_excerpt + updatedAt", async () => {
		const authorId = "edit-comment-author";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "edit-comment-post-author",
			commentAuthorId: authorId,
			commentBody: "original body content",
		});

		const result = await editComment(env, {
			commentId,
			actorId: authorId,
			body: "edited body — fresh content here.",
		});
		expect(result.body).toBe("edited body — fresh content here.");
		expect(result.commentId).toBe(commentId);

		const view = await env.PHOENIX_DB.prepare(
			"SELECT body, body_excerpt FROM comment_view WHERE id = ?",
		)
			.bind(commentId)
			.first<{body: string; body_excerpt: string}>();
		expect(view!.body).toBe("edited body — fresh content here.");
		expect(view!.body_excerpt).toContain("edited body — fresh content");
	});

	it("non-author edit throws UnauthorizedCommentMutationError", async () => {
		const {commentId} = await seedPostAndComment({
			postAuthorId: "ec-owner-post",
			commentAuthorId: "ec-owner",
		});
		try {
			await editComment(env, {
				commentId,
				actorId: "different-user",
				body: "evil edit",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("UnauthorizedCommentMutationError");
		}
	});

	it("editComment on unknown comment id throws CommentNotFoundError", async () => {
		await seedPostAndComment({
			postAuthorId: "ec-missing-post",
			commentAuthorId: "ec-missing",
		});
		try {
			await editComment(env, {
				commentId: "comm_DOES_NOT_EXIST",
				actorId: "ec-missing",
				body: "x",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentNotFoundError");
		}
	});

	it("editComment with empty body rejects with body_required", async () => {
		const authorId = "ec-empty";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "ec-empty-post",
			commentAuthorId: authorId,
		});
		try {
			await editComment(env, {commentId, actorId: authorId, body: "    "});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect((err as Error & {code: string}).code).toBe("body_required");
		}
	});
});

describe("pano/module deleteComment — d1-direct/task_8", () => {
	it("deleting a leaf comment fully removes the comment_view row + decrements commentCount", async () => {
		const authorId = "del-leaf-author";
		const {postId, commentId} = await seedPostAndComment({
			postAuthorId: "del-leaf-post",
			commentAuthorId: authorId,
			commentBody: "leaf comment to be removed",
		});

		const result = await deleteComment(env, {commentId, actorId: authorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);
		expect(result.placeholder).toBeNull();

		const gone = await env.PHOENIX_DB.prepare("SELECT id FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first();
		expect(gone).toBeNull();

		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(0);

		// Per-post reader confirms the row is absent from the tree.
		const comments = await listComments(env, postId);
		expect(comments.find((c) => c.id === commentId)).toBeUndefined();
	});

	it("deleting a parent comment with replies preserves tree structure with [silindi] placeholder", async () => {
		const parentAuthorId = "del-parent-author";
		const replyAuthorId = "del-parent-reply-author";
		const {postId, commentId: parentId} = await seedPostAndComment({
			postAuthorId: "del-parent-post",
			commentAuthorId: parentAuthorId,
			commentBody: "parent comment with replies",
		});

		const reply = await addComment(env, {
			postId,
			authorId: replyAuthorId,
			authorName: "reply author",
			body: "the reply that keeps the parent in the tree",
			parentId,
		});

		const result = await deleteComment(env, {commentId: parentId, actorId: parentAuthorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);
		expect(result.placeholder).not.toBeNull();
		expect(result.placeholder!.body).toBe("[silindi]");
		expect(result.placeholder!.authorId).toBe("");
		expect(result.placeholder!.deletedAt).toBeInstanceOf(Date);

		// comment_view row stays with body_excerpt rewritten + deleted_at set.
		const view = await env.PHOENIX_DB.prepare(
			"SELECT body_excerpt, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(parentId)
			.first<{body_excerpt: string; deleted_at: number | null}>();
		expect(view).not.toBeNull();
		expect(view!.body_excerpt).toBe("[silindi]");
		expect(view!.deleted_at).not.toBeNull();

		// Reply's comment_view row untouched.
		const replyView = await env.PHOENIX_DB.prepare(
			"SELECT body, body_excerpt, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(reply.commentId)
			.first<{body: string; body_excerpt: string; deleted_at: number | null}>();
		expect(replyView).not.toBeNull();
		expect(replyView!.body).toBe("the reply that keeps the parent in the tree");
		expect(replyView!.deleted_at).toBeNull();

		// post_summary.comment_count decremented by 1 (the parent); reply still counts.
		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(1);

		// Per-post reader returns the placeholder for the parent + reply intact.
		const comments = await listComments(env, postId);
		const parentRow = comments.find((c) => c.id === parentId);
		expect(parentRow).toBeDefined();
		expect(parentRow!.body).toBe("[silindi]");
		expect(parentRow!.authorId).toBe("");
		const replyRow = comments.find((c) => c.id === reply.commentId);
		expect(replyRow).toBeDefined();
		expect(replyRow!.body).toBe("the reply that keeps the parent in the tree");
	});

	it("non-author delete throws UnauthorizedCommentMutationError", async () => {
		const {commentId} = await seedPostAndComment({
			postAuthorId: "dc-owner-post",
			commentAuthorId: "dc-owner",
		});
		try {
			await deleteComment(env, {commentId, actorId: "different-user"});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("UnauthorizedCommentMutationError");
		}
	});

	it("deleteComment on already-deleted (parent-with-replies) comment is an idempotent no-op", async () => {
		const parentAuthorId = "dc-idempotent-parent";
		const {postId, commentId: parentId} = await seedPostAndComment({
			postAuthorId: "dc-idempotent-post",
			commentAuthorId: parentAuthorId,
		});
		await addComment(env, {
			postId,
			authorId: "dc-idempotent-child",
			authorName: "child",
			body: "reply",
			parentId,
		});

		const first = await deleteComment(env, {commentId: parentId, actorId: parentAuthorId});
		expect(first.deleted).toBe(true);
		expect(first.hasReplies).toBe(true);

		const second = await deleteComment(env, {commentId: parentId, actorId: parentAuthorId});
		expect(second.deleted).toBe(false);
		expect(second.hasReplies).toBe(true);
	});

	it("deleteComment on unknown comment id throws CommentNotFoundError", async () => {
		await seedPostAndComment({
			postAuthorId: "dc-missing-post",
			commentAuthorId: "dc-missing",
		});
		try {
			await deleteComment(env, {
				commentId: "comm_DOES_NOT_EXIST",
				actorId: "dc-missing",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentNotFoundError");
		}
	});
});
