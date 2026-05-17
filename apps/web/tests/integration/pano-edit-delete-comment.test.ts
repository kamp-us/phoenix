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
	voteOnComment,
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

/**
 * Atomicity invariant (d1-direct-review-fixes task_3).
 *
 * A successful `deleteComment(...)` must collapse every mutating statement —
 * the conditional karma decrement, `DELETE FROM comment_vote`, `DELETE FROM
 * user_vote`, and the branch-dependent terminal (`UPDATE comment_view` for
 * parent-with-replies or `DELETE FROM comment_view` for leaves) — into one
 * `env.PHOENIX_DB.batch([...])` call. The post `commentCount` decrement +
 * `recomputePanoStats` stay out of the batch (recomputable; not
 * atomicity-critical).
 *
 * Branches:
 *   - leaf, `priorScore === 0` → 3 statements (no karma; ends with DELETE).
 *   - leaf, `priorScore > 0`  → 4 statements (karma first; ends with DELETE).
 *   - parent-with-replies, `priorScore === 0` → 3 statements (no karma; ends
 *     with UPDATE).
 *   - parent-with-replies, `priorScore > 0` → 4 statements (karma first;
 *     ends with UPDATE).
 */
describe("pano.deleteComment — atomic single-batch write (d1-direct-review-fixes task_3)", () => {
	/**
	 * Wraps `env` so callers can spy on `PHOENIX_DB.batch` and the
	 * `.prepare(sql).bind(...).run()` chain without losing the real D1
	 * binding's behaviour. Same shape as the deletePost spy in
	 * `pano-edit-delete-post.test.ts` — duplicated rather than shared so
	 * each test file stays self-contained.
	 */
	function spyEnv(real: Env) {
		let batchCalls = 0;
		const batchStatementCounts: number[] = [];
		const realDb = real.PHOENIX_DB;
		const wrappedStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
			return new Proxy(stmt, {
				get(target, prop, receiver) {
					const orig = Reflect.get(target, prop, receiver);
					if (prop === "bind" && typeof orig === "function") {
						return (...args: unknown[]) => {
							const bound = (orig as (...a: unknown[]) => D1PreparedStatement).apply(target, args);
							return wrappedStatement(bound);
						};
					}
					return typeof orig === "function" ? orig.bind(target) : orig;
				},
			});
		};
		const wrappedDb = new Proxy(realDb, {
			get(target, prop, receiver) {
				const orig = Reflect.get(target, prop, receiver);
				if (prop === "batch" && typeof orig === "function") {
					return (stmts: D1PreparedStatement[]) => {
						batchCalls += 1;
						batchStatementCounts.push(stmts.length);
						return (orig as (s: D1PreparedStatement[]) => unknown).call(target, stmts);
					};
				}
				if (prop === "prepare" && typeof orig === "function") {
					return (sql: string) => {
						const stmt = (orig as (s: string) => D1PreparedStatement).call(target, sql);
						return wrappedStatement(stmt);
					};
				}
				return typeof orig === "function" ? orig.bind(target) : orig;
			},
		});
		const wrappedEnv = new Proxy(real, {
			get(target, prop, receiver) {
				if (prop === "PHOENIX_DB") return wrappedDb;
				return Reflect.get(target, prop, receiver);
			},
		}) as Env;
		return {
			env: wrappedEnv,
			getCounts: () => ({
				batchCalls,
				batchStatementCounts: [...batchStatementCounts],
			}),
		};
	}

	it("leaf, priorScore === 0: one batch with 3 statements (comment_vote + user_vote + DELETE comment_view)", async () => {
		const authorId = "atomic-del-comment-leaf-zero";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "atomic-del-comment-leaf-zero-post",
			commentAuthorId: authorId,
		});

		const spy = spyEnv(env);
		const result = await deleteComment(spy.env, {commentId, actorId: authorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.batchStatementCounts[0]).toBe(3);
	});

	it("leaf, priorScore > 0: one batch with 4 statements (karma first, ends with DELETE comment_view)", async () => {
		const authorId = "atomic-del-comment-leaf-nonzero-author";
		const voterId = "atomic-del-comment-leaf-nonzero-voter";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "atomic-del-comment-leaf-nonzero-post",
			commentAuthorId: authorId,
		});

		await voteOnComment(env, {commentId, voterId});

		// Sanity: comment_view.score is now 1.
		const meta = (await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first()) as {score: number} | null;
		expect(meta!.score).toBe(1);

		const spy = spyEnv(env);
		const result = await deleteComment(spy.env, {commentId, actorId: authorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.batchStatementCounts[0]).toBe(4);

		// Sanity: row really is gone (proves the terminal in the batch was
		// the DELETE, not the soft-update).
		const gone = await env.PHOENIX_DB.prepare("SELECT id FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first();
		expect(gone).toBeNull();
	});

	it("parent-with-replies, priorScore === 0: one batch with 3 statements (comment_vote + user_vote + UPDATE comment_view)", async () => {
		const parentAuthorId = "atomic-del-comment-parent-zero-author";
		const {postId, commentId: parentId} = await seedPostAndComment({
			postAuthorId: "atomic-del-comment-parent-zero-post",
			commentAuthorId: parentAuthorId,
		});
		await addComment(env, {
			postId,
			authorId: "atomic-del-comment-parent-zero-child",
			authorName: "child",
			body: "keeps the parent in the tree",
			parentId,
		});

		const spy = spyEnv(env);
		const result = await deleteComment(spy.env, {commentId: parentId, actorId: parentAuthorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.batchStatementCounts[0]).toBe(3);

		// Sanity: parent row still exists with body_excerpt = SILINDI (proves
		// the terminal was the UPDATE, not the DELETE).
		const view = await env.PHOENIX_DB.prepare(
			"SELECT body_excerpt, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(parentId)
			.first<{body_excerpt: string; deleted_at: number | null}>();
		expect(view).not.toBeNull();
		expect(view!.body_excerpt).toBe("[silindi]");
		expect(view!.deleted_at).not.toBeNull();
	});

	it("parent-with-replies, priorScore > 0: one batch with 4 statements (karma first, ends with UPDATE comment_view)", async () => {
		const parentAuthorId = "atomic-del-comment-parent-nonzero-author";
		const voterId = "atomic-del-comment-parent-nonzero-voter";
		const {postId, commentId: parentId} = await seedPostAndComment({
			postAuthorId: "atomic-del-comment-parent-nonzero-post",
			commentAuthorId: parentAuthorId,
		});
		await addComment(env, {
			postId,
			authorId: "atomic-del-comment-parent-nonzero-child",
			authorName: "child",
			body: "keeps the parent in the tree",
			parentId,
		});

		await voteOnComment(env, {commentId: parentId, voterId});

		const meta = (await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(parentId)
			.first()) as {score: number} | null;
		expect(meta!.score).toBe(1);

		const spy = spyEnv(env);
		const result = await deleteComment(spy.env, {commentId: parentId, actorId: parentAuthorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.batchStatementCounts[0]).toBe(4);
	});

	it("post commentCount decrement still runs after the batch resolves", async () => {
		const authorId = "atomic-del-comment-count-author";
		const {postId, commentId} = await seedPostAndComment({
			postAuthorId: "atomic-del-comment-count-post",
			commentAuthorId: authorId,
		});

		const beforeSummary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(beforeSummary!.comment_count).toBe(1);

		const spy = spyEnv(env);
		await deleteComment(spy.env, {commentId, actorId: authorId});
		expect(spy.getCounts().batchCalls).toBe(1);

		const afterSummary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(afterSummary!.comment_count).toBe(0);
	});
});
