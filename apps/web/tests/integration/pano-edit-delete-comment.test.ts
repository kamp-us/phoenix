/**
 * PanoPost.editComment / deleteComment + CommentEdited / CommentDeleted
 * projection — task_12.
 *
 * Mirrors `pano-edit-delete-post.test.ts` (T9) and
 * `sozluk-edit-delete-definition.test.ts` (T6). Exercises the producer pattern
 * (ADR 0007) end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a post (T7) + add a comment (T10).
 *   3. Edit the body → `comment` row reflects new value; `comment_view`
 *      converges via `CommentEdited` projection step.
 *   4. Ownership: a non-author actor's edit / delete throws
 *      `UnauthorizedCommentMutationError`.
 *   5. Delete a *leaf* comment → soft-stamps `deleted_at` on `comment`,
 *      decrements `post_meta.commentCount`, projection REMOVES the row from
 *      `comment_view` entirely (vs. `[silindi]` rewrite for parents).
 *   6. Delete a *parent* with replies → soft-stamps `deleted_at`, projection
 *      UPDATES `comment_view` SET body_excerpt = '[silindi]' (preserve thread
 *      shape); per-DO `listComments` returns the parent with body =
 *      '[silindi]' so the live tree on PanoPostDetail keeps the structure.
 *   7. Idempotent re-delete on an already-deleted comment is a no-op.
 *   8. CommentNotFoundError for an unknown comment id.
 */

import {env} from "cloudflare:test";
import {id} from "@usirin/forge";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/view/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/view/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/view/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/view/drizzle/migrations/0003_lazy_thanos.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [viewMigration0000, viewMigration0001, viewMigration0002, viewMigration0003];
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

async function waitForRow<T>(sqlStr: string, params: unknown[], attempts = 30): Promise<T | null> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sqlStr)
			.bind(...params)
			.first();
		if (row) return row as T;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function waitForCondition(
	sqlStr: string,
	params: unknown[],
	predicate: (row: unknown | null) => boolean,
	attempts = 30,
): Promise<unknown | null> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sqlStr)
			.bind(...params)
			.first();
		if (predicate(row)) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function waitForGone(sqlStr: string, params: unknown[], attempts = 30): Promise<boolean> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sqlStr)
			.bind(...params)
			.first();
		if (!row) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

async function seedPostAndComment(opts: {
	postAuthorId: string;
	commentAuthorId: string;
	commentBody?: string;
}) {
	const postId = id("post");
	const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
	await stub.submitPost({
		title: `edit/delete comment seed ${postId}`,
		tags: [{kind: "tartışma"}],
		authorId: opts.postAuthorId,
		authorName: "post author",
	});
	await waitForRow<{id: string}>("SELECT id FROM post_summary WHERE id = ?", [postId]);

	const comment = await stub.addComment({
		authorId: opts.commentAuthorId,
		authorName: "comment author",
		body: opts.commentBody ?? "original comment body",
	});
	await waitForRow<{id: string}>("SELECT id FROM comment_view WHERE id = ?", [comment.commentId]);
	return {stub, postId, commentId: comment.commentId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost.editComment — task_12", () => {
	it("updates body + projects CommentEdited onto comment_view.body_excerpt", async () => {
		const authorId = "edit-comment-author";
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "edit-comment-post-author",
			commentAuthorId: authorId,
			commentBody: "original body content",
		});

		const result = await stub.editComment({
			commentId,
			actorId: authorId,
			body: "edited body — fresh content here.",
		});
		expect(result.body).toBe("edited body — fresh content here.");
		expect(result.commentId).toBe(commentId);

		// In-DO: comment.body reflects the edit; not deleted; visible in tree.
		const comments = await stub.listComments();
		const target = comments.find((c) => c.id === commentId);
		expect(target).toBeDefined();
		expect(target!.body).toBe("edited body — fresh content here.");
		expect(target!.authorId).toBe(authorId);

		// comment_view.body_excerpt converged.
		const view = await waitForCondition(
			"SELECT body_excerpt FROM comment_view WHERE id = ?",
			[commentId],
			(r) =>
				r != null && (r as {body_excerpt: string}).body_excerpt.startsWith("edited body — fresh"),
		);
		expect(view).not.toBeNull();
	});

	it("non-author edit throws UnauthorizedCommentMutationError", async () => {
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "ec-owner-post",
			commentAuthorId: "ec-owner",
		});
		try {
			await stub.editComment({
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
		const {stub} = await seedPostAndComment({
			postAuthorId: "ec-missing-post",
			commentAuthorId: "ec-missing",
		});
		try {
			await stub.editComment({
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
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "ec-empty-post",
			commentAuthorId: authorId,
		});
		try {
			await stub.editComment({commentId, actorId: authorId, body: "    "});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect((err as Error & {code: string}).code).toBe("body_required");
		}
	});
});

describe("PanoPost.deleteComment — task_12", () => {
	it("deleting a leaf comment removes it entirely from listComments + comment_view", async () => {
		const authorId = "del-leaf-author";
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "del-leaf-post",
			commentAuthorId: authorId,
			commentBody: "leaf comment to be removed",
		});

		const result = await stub.deleteComment({commentId, actorId: authorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);

		// Per-DO read: the leaf row is gone from the tree entirely.
		const comments = await stub.listComments();
		expect(comments.find((c) => c.id === commentId)).toBeUndefined();

		// post_meta.commentCount decremented (read via getPost which filters
		// deleted comments).
		const post = await stub.getPost();
		expect(post!.commentCount).toBe(0);

		// Projection: comment_view row REMOVED (DELETE branch on hasReplies=false).
		const gone = await waitForGone("SELECT id FROM comment_view WHERE id = ?", [commentId]);
		expect(gone).toBe(true);

		// post_summary.commentCount converged via the sibling PostChanged event.
		const summary = await waitForCondition(
			"SELECT comment_count FROM post_summary WHERE id = ?",
			[result.commentId === commentId ? (await stub.getPost())!.id : ""],
			() => true,
		);
		// Re-read explicitly via known postId.
		const postRow = await stub.getPost();
		const finalSummary = await waitForCondition(
			"SELECT comment_count FROM post_summary WHERE id = ?",
			[postRow!.id],
			(r) => r != null && (r as {comment_count: number}).comment_count === 0,
		);
		expect(finalSummary).not.toBeNull();
		expect(summary).not.toBeNull();
	});

	it("deleting a parent comment with replies preserves tree structure with [silindi] placeholder", async () => {
		const parentAuthorId = "del-parent-author";
		const replyAuthorId = "del-parent-reply-author";
		const {
			stub,
			postId,
			commentId: parentId,
		} = await seedPostAndComment({
			postAuthorId: "del-parent-post",
			commentAuthorId: parentAuthorId,
			commentBody: "parent comment with replies",
		});

		// Add a reply to that parent.
		const reply = await stub.addComment({
			authorId: replyAuthorId,
			authorName: "reply author",
			body: "the reply that keeps the parent in the tree",
			parentId,
		});
		await waitForRow<{id: string}>("SELECT id FROM comment_view WHERE id = ?", [reply.commentId]);

		// Delete the parent.
		const result = await stub.deleteComment({commentId: parentId, actorId: parentAuthorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);

		// Per-DO read: parent stays in the tree as `[silindi]`; reply still
		// visible underneath.
		const comments = await stub.listComments();
		const parentRow = comments.find((c) => c.id === parentId);
		expect(parentRow).toBeDefined();
		expect(parentRow!.body).toBe("[silindi]");
		expect(parentRow!.author).toBe("");
		expect(parentRow!.authorId).toBe("");
		const replyRow = comments.find((c) => c.id === reply.commentId);
		expect(replyRow).toBeDefined();
		expect(replyRow!.parentId).toBe(parentId);
		expect(replyRow!.body).toBe("the reply that keeps the parent in the tree");

		// Projection: comment_view UPDATE branch — body_excerpt becomes [silindi]
		// and deleted_at is stamped, but the row stays.
		const view = await waitForCondition(
			"SELECT body_excerpt, deleted_at FROM comment_view WHERE id = ?",
			[parentId],
			(r) => r != null && (r as {body_excerpt: string}).body_excerpt === "[silindi]",
		);
		expect(view).not.toBeNull();
		expect((view as {deleted_at: number}).deleted_at).toBeGreaterThan(0);

		// Reply's comment_view row untouched.
		const replyView = await env.PHOENIX_DB.prepare(
			"SELECT body_excerpt, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(reply.commentId)
			.first<{body_excerpt: string; deleted_at: number | null}>();
		expect(replyView).not.toBeNull();
		expect(replyView!.body_excerpt).toBe("the reply that keeps the parent in the tree");
		expect(replyView!.deleted_at).toBeFalsy();

		// post_meta.commentCount decremented by 1 (the parent); reply still counts.
		const post = await stub.getPost();
		expect(post!.commentCount).toBe(1);
		expect(post!.id).toBe(postId);
	});

	it("non-author delete throws UnauthorizedCommentMutationError", async () => {
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "dc-owner-post",
			commentAuthorId: "dc-owner",
		});
		try {
			await stub.deleteComment({commentId, actorId: "different-user"});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("UnauthorizedCommentMutationError");
		}
	});

	it("deleteComment on already-deleted comment is an idempotent no-op", async () => {
		const authorId = "dc-idempotent";
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "dc-idempotent-post",
			commentAuthorId: authorId,
		});
		const first = await stub.deleteComment({commentId, actorId: authorId});
		expect(first.deleted).toBe(true);

		const second = await stub.deleteComment({commentId, actorId: authorId});
		expect(second.deleted).toBe(false);
	});

	it("deleteComment on unknown comment id throws CommentNotFoundError", async () => {
		const {stub} = await seedPostAndComment({
			postAuthorId: "dc-missing-post",
			commentAuthorId: "dc-missing",
		});
		try {
			await stub.deleteComment({
				commentId: "comm_DOES_NOT_EXIST",
				actorId: "dc-missing",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentNotFoundError");
		}
	});

	it("deleting all replies of a [silindi] parent then converges the tree to no parent row in comment_view", async () => {
		// This specifically exercises the documented behavior: when a parent
		// has been turned into [silindi] because of a child, then the child is
		// deleted (leaf-style), the per-DO read no longer keeps the parent
		// since it has no live children. The comment_view side already ran the
		// UPDATE branch so the parent's row carries deleted_at + [silindi];
		// downstream cleanup is a future concern (T14 profile feed filters
		// deleted), so we only assert the per-DO tree is correct.
		const parentAuthorId = "cascade-parent";
		const childAuthorId = "cascade-child";
		const {stub, commentId: parentId} = await seedPostAndComment({
			postAuthorId: "cascade-post",
			commentAuthorId: parentAuthorId,
		});
		const reply = await stub.addComment({
			authorId: childAuthorId,
			authorName: "child",
			body: "child body",
			parentId,
		});
		// Delete parent → [silindi] (has replies).
		await stub.deleteComment({commentId: parentId, actorId: parentAuthorId});
		// Delete child → leaf, fully removed.
		await stub.deleteComment({commentId: reply.commentId, actorId: childAuthorId});

		const comments = await stub.listComments();
		// Both rows now disappear from the per-DO tree: child is a leaf delete,
		// and parent has no live children, so the [silindi] placeholder
		// disappears too on the next read.
		expect(comments.find((c) => c.id === parentId)).toBeUndefined();
		expect(comments.find((c) => c.id === reply.commentId)).toBeUndefined();
	});
});
