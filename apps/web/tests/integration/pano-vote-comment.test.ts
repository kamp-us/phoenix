/**
 * `voteOnComment` / `retractCommentVote` on D1-direct.
 *
 * Exercises the D1-direct comment vote module surface end-to-end inside
 * workerd:
 *   1. Apply view migrations.
 *   2. Seed a post + comment (D1-direct paths).
 *   3. Cast a vote → score 0 → 1 → `comment_vote` row exists →
 *      `user_vote` MV row exists → `user_profile.total_karma` for the
 *      comment's author goes 0 → 1 → `comment_view.score` converges to 1.
 *   4. Idempotency: a second vote from the same user is a no-op (score
 *      stays at 1, karma stays at 1, one `comment_vote` row exists).
 *   5. Retract the vote → score 0 → user_vote row gone → karma 0 →
 *      comment_view score 0.
 *   6. Vote → unvote → vote round-trip restores score 1, karma 1,
 *      exactly one `comment_vote` row.
 *   7. `CommentNotFoundError` for an unknown comment id.
 *
 * Zero `runInDurableObject` blocks — the module writes D1 directly.
 */
import {env} from "cloudflare:workers";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	addComment,
	retractCommentVote,
	submitPost,
	voteOnComment,
} from "../../worker/features/pano/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
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

async function seedPostAndComment(opts: {
	postAuthorId: string;
	commentAuthorId: string;
	commentBody?: string;
}) {
	const post = await submitPost(env, {
		title: `vote-on-comment seed ${opts.postAuthorId}`,
		tags: [{kind: "tartışma"}],
		authorId: opts.postAuthorId,
		authorName: "post author",
	});
	const comment = await addComment(env, {
		postId: post.postId,
		authorId: opts.commentAuthorId,
		authorName: "comment author",
		body: opts.commentBody ?? "a comment to vote on",
	});
	return {postId: post.postId, commentId: comment.commentId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano/module voteOnComment", () => {
	it("casts a vote, recomputes comment.score, writes user_vote + karma + comment_view", async () => {
		const postAuthorId = "p-author-cv-1";
		const commentAuthorId = "c-author-cv-1";
		const voterId = "voter-cv-1";
		const {commentId} = await seedPostAndComment({postAuthorId, commentAuthorId});

		const result = await voteOnComment(env, {commentId, voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);
		expect(result.commentId).toBe(commentId);

		// comment_vote row exists.
		const vote = await env.PHOENIX_DB.prepare(
			"SELECT voter_id FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first();
		expect(vote).not.toBeNull();

		// user_vote MV row landed for target_kind='comment'.
		const voteRow = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
		)
			.bind(voterId, commentId)
			.first();
		expect(voteRow).not.toBeNull();

		// comment_view.score updated inline.
		const view = await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first<{score: number}>();
		expect(view!.score).toBe(1);

		// karma 0 → 1 for the comment's author (NOT the post author).
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const commentAuthorId = "c-author-cv-idem";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-idem",
			commentAuthorId,
		});
		const voterId = "voter-cv-idem";

		const first = await voteOnComment(env, {commentId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await voteOnComment(env, {commentId, voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);
		expect(second.myVote).toBe(1);

		// karma stays at 1 (not 2).
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);

		// vote table has exactly one row for this (comment, voter).
		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);
	});

	it("retractCommentVote removes the row, recomputes score, removes user_vote + decrements karma", async () => {
		const commentAuthorId = "c-author-cv-retract";
		const voterId = "voter-cv-retract";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-retract",
			commentAuthorId,
		});

		await voteOnComment(env, {commentId, voterId});

		const retract = await retractCommentVote(env, {commentId, voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		// comment_view.score back to 0.
		const view = await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first<{score: number}>();
		expect(view!.score).toBe(0);

		// user_vote row removed.
		const userVote = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, commentId)
			.first();
		expect(userVote).toBeNull();

		// karma decremented.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-noop",
			commentAuthorId: "c-author-cv-noop",
		});

		const result = await retractCommentVote(env, {commentId, voterId: "voter-cv-noop"});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
		expect(result.myVote).toBeNull();
	});

	it("vote → unvote → vote round-trip ends with score 1 and one comment_vote row", async () => {
		const commentAuthorId = "c-author-cv-rt";
		const voterId = "voter-cv-rt";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-rt",
			commentAuthorId,
		});

		await voteOnComment(env, {commentId, voterId});
		await retractCommentVote(env, {commentId, voterId});
		const final = await voteOnComment(env, {commentId, voterId});
		expect(final.score).toBe(1);
		expect(final.changed).toBe(true);

		// comment_vote has exactly one row.
		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		// karma at 1 for the comment author.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voteOnComment on an unknown comment id rejects with CommentNotFoundError", async () => {
		await seedPostAndComment({
			postAuthorId: "p-author-cv-missing",
			commentAuthorId: "c-author-cv-missing",
		});
		try {
			await voteOnComment(env, {commentId: "comm_DOES_NOT_EXIST", voterId: "voter-x"});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentNotFoundError");
		}
	});
});
