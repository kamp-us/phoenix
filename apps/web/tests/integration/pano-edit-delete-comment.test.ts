/**
 * `Pano.editComment` / `Pano.deleteComment` — Effect service surface
 * (effect-migration task 5).
 *
 * Same lifecycle / wire-code surface as the legacy `pano/module.ts`;
 * atomicity is now enforced by `Drizzle.batch(...)`. The spy-env-style atomic
 * batch counters from the legacy module are dropped (the drizzle builder is
 * captured at layer build time, before the proxy is in place). The behavioral
 * guarantees they were verifying — leaf path removes the row, parent-with-
 * replies path stamps the placeholder, vote rows drop, karma decrements,
 * commentCount refresh runs after — remain fully covered below.
 */
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	type AddCommentInput,
	type DeleteCommentInput,
	type EditCommentInput,
	Pano,
	PanoLive,
	type SubmitPostInput,
	type VoteOnCommentInput,
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

function editComment(input: EditCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.editComment(input);
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

function voteOnComment(input: VoteOnCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.voteOnComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

async function listCommentRows(postId: string) {
	const page = await Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.listCommentsKeyset(postId, {first: 200});
		}).pipe(Effect.provide(TestLive)),
	);
	return page.rows;
}

function editCommentProgram(input: EditCommentInput) {
	return Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.editComment(input);
	}).pipe(Effect.provide(TestLive));
}

function deleteCommentProgram(input: DeleteCommentInput) {
	return Effect.gen(function* () {
		const pano = yield* Pano;
		return yield* pano.deleteComment(input);
	}).pipe(Effect.provide(TestLive));
}

async function expectFailure(
	program: Effect.Effect<unknown, unknown, never>,
	tag: string,
	code?: string,
): Promise<void> {
	const exit = await Effect.runPromise(Effect.exit(program));
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	const found = Cause.findError(exit.cause);
	if (found._tag !== "Success") throw new Error("expected typed failure");
	const err = found.success as {_tag?: string; code?: string};
	expect(err._tag).toBe(tag);
	if (code !== undefined) expect(err.code).toBe(code);
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

async function seedProfile(userId: string) {
	const now = Math.floor(Date.now() / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO user_profile (
			user_id, username, display_name, image,
			total_karma, definition_count, post_count, comment_count,
			updated_at, last_event_id
		) VALUES (?, NULL, NULL, NULL, 0, 0, 0, 0, ?, '')
		ON CONFLICT(user_id) DO NOTHING`,
	)
		.bind(userId, now)
		.run();
}

async function seedPostAndComment(opts: {
	postAuthorId: string;
	commentAuthorId: string;
	commentBody?: string;
	postTitle?: string;
}) {
	await seedProfile(opts.postAuthorId);
	await seedProfile(opts.commentAuthorId);
	const post = await submitPost({
		title: opts.postTitle ?? `edit/delete seed ${opts.postAuthorId}`,
		tags: [{kind: "tartışma"}],
		authorId: opts.postAuthorId,
		authorName: "post author",
	});
	const comment = await addComment({
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

describe("Pano.editComment", () => {
	it("updates body + body_excerpt + updatedAt", async () => {
		const authorId = "edit-comment-author";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "edit-comment-post-author",
			commentAuthorId: authorId,
			commentBody: "original body content",
		});

		const result = await editComment({
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

	it("non-author edit rejects with UnauthorizedCommentMutation", async () => {
		const {commentId} = await seedPostAndComment({
			postAuthorId: "ec-owner-post",
			commentAuthorId: "ec-owner",
		});
		await expectFailure(
			editCommentProgram({commentId, actorId: "different-user", body: "evil edit"}),
			"pano/UnauthorizedCommentMutation",
		);
	});

	it("editComment on unknown comment id rejects with CommentNotFound", async () => {
		await seedPostAndComment({
			postAuthorId: "ec-missing-post",
			commentAuthorId: "ec-missing",
		});
		await expectFailure(
			editCommentProgram({commentId: "comm_DOES_NOT_EXIST", actorId: "ec-missing", body: "x"}),
			"pano/CommentNotFound",
		);
	});

	it("editComment with empty body rejects with CommentValidation body_required", async () => {
		const authorId = "ec-empty";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "ec-empty-post",
			commentAuthorId: authorId,
		});
		await expectFailure(
			editCommentProgram({commentId, actorId: authorId, body: "    "}),
			"pano/CommentValidation",
			"body_required",
		);
	});

	it("editComment with body over 5 000 chars rejects with body_too_long", async () => {
		const authorId = "ec-long";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "ec-long-post",
			commentAuthorId: authorId,
		});
		await expectFailure(
			editCommentProgram({commentId, actorId: authorId, body: "x".repeat(5_001)}),
			"pano/CommentValidation",
			"body_too_long",
		);
	});
});

describe("Pano.deleteComment", () => {
	it("deleting a leaf comment fully removes the comment_view row + decrements commentCount", async () => {
		const authorId = "del-leaf-author";
		const {postId, commentId} = await seedPostAndComment({
			postAuthorId: "del-leaf-post",
			commentAuthorId: authorId,
			commentBody: "leaf comment to be removed",
		});

		const result = await deleteComment({commentId, actorId: authorId});
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

		const comments = await listCommentRows(postId);
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

		const reply = await addComment({
			postId,
			authorId: replyAuthorId,
			authorName: "reply author",
			body: "the reply that keeps the parent in the tree",
			parentId,
		});

		const result = await deleteComment({commentId: parentId, actorId: parentAuthorId});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);
		expect(result.placeholder).not.toBeNull();
		expect(result.placeholder!.body).toBe("[silindi]");
		expect(result.placeholder!.authorId).toBe("");
		expect(result.placeholder!.deletedAt).toBeInstanceOf(Date);

		const view = await env.PHOENIX_DB.prepare(
			"SELECT body_excerpt, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(parentId)
			.first<{body_excerpt: string; deleted_at: number | null}>();
		expect(view).not.toBeNull();
		expect(view!.body_excerpt).toBe("[silindi]");
		expect(view!.deleted_at).not.toBeNull();

		const replyView = await env.PHOENIX_DB.prepare(
			"SELECT body, body_excerpt, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(reply.commentId)
			.first<{body: string; body_excerpt: string; deleted_at: number | null}>();
		expect(replyView).not.toBeNull();
		expect(replyView!.body).toBe("the reply that keeps the parent in the tree");
		expect(replyView!.deleted_at).toBeNull();

		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(1);

		const comments = await listCommentRows(postId);
		const parentRow = comments.find((c) => c.id === parentId);
		expect(parentRow).toBeDefined();
		expect(parentRow!.body).toBe("[silindi]");
		expect(parentRow!.authorId).toBe("");
		const replyRow = comments.find((c) => c.id === reply.commentId);
		expect(replyRow).toBeDefined();
		expect(replyRow!.body).toBe("the reply that keeps the parent in the tree");
	});

	it("non-author delete rejects with UnauthorizedCommentMutation", async () => {
		const {commentId} = await seedPostAndComment({
			postAuthorId: "dc-owner-post",
			commentAuthorId: "dc-owner",
		});
		await expectFailure(
			deleteCommentProgram({commentId, actorId: "different-user"}),
			"pano/UnauthorizedCommentMutation",
		);
	});

	it("deleteComment on already-deleted (parent-with-replies) comment is an idempotent no-op", async () => {
		const parentAuthorId = "dc-idempotent-parent";
		const {postId, commentId: parentId} = await seedPostAndComment({
			postAuthorId: "dc-idempotent-post",
			commentAuthorId: parentAuthorId,
		});
		await addComment({
			postId,
			authorId: "dc-idempotent-child",
			authorName: "child",
			body: "reply",
			parentId,
		});

		const first = await deleteComment({commentId: parentId, actorId: parentAuthorId});
		expect(first.deleted).toBe(true);
		expect(first.hasReplies).toBe(true);

		const second = await deleteComment({commentId: parentId, actorId: parentAuthorId});
		expect(second.deleted).toBe(false);
		expect(second.hasReplies).toBe(true);
	});

	it("deleteComment on unknown comment id rejects with CommentNotFound", async () => {
		await seedPostAndComment({
			postAuthorId: "dc-missing-post",
			commentAuthorId: "dc-missing",
		});
		await expectFailure(
			deleteCommentProgram({commentId: "comm_DOES_NOT_EXIST", actorId: "dc-missing"}),
			"pano/CommentNotFound",
		);
	});

	it("drops comment_vote + user_vote mirror rows and decrements karma on delete-with-votes", async () => {
		const authorId = "dc-with-votes-author";
		const voterId = "dc-with-votes-voter";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "dc-with-votes-post",
			commentAuthorId: authorId,
		});

		await voteOnComment({commentId, voterId});

		const karmaBefore = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(karmaBefore!.total_karma).toBe(1);

		await deleteComment({commentId, actorId: authorId});

		const commentVotes = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ?",
		)
			.bind(commentId)
			.first()) as {n: number} | null;
		expect(commentVotes!.n).toBe(0);

		const userVotes = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE target_kind = 'comment' AND target_id = ?",
		)
			.bind(commentId)
			.first()) as {n: number} | null;
		expect(userVotes!.n).toBe(0);

		const karmaAfter = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(karmaAfter!.total_karma).toBe(0);
	});
});
